import { Notice, Platform, Plugin, TFile, TFolder, Workspace, WorkspaceLeaf } from "obsidian";
import { ensureDefaultPacks, loadPacks } from "./packs/loader";
import { runPack, type PackRuntimeEvent, type PackRunResult } from "./packs/runtime";
import type { AgentPack } from "./packs/types";
import { ConsentManager } from "./consent/manager";
import { UndoBuffer } from "./consent/undo";
import { OpenAgentSettingsTab, DEFAULT_SETTINGS, type PluginSettings } from "./settings";
import { SessionStore, loadStoredTurnsFile, type SessionMeta, type StoredTurn } from "./sessions";
import { ToolRegistry } from "./tools/registry";
import { vaultTools } from "./tools/vault";
import { openAgentImageGenerateTool } from "./tools/image-generate";
import { openAgentImageRegionTool } from "./tools/image-region";
import { ensureParentFolder } from "./tools/vault/ensure-folder";
import { CHAT_VIEW_TYPE, ChatView } from "./view";
import { oaAnnotateTools } from "./images/geometry";
import { oaSanitizeModelCategories } from "./models/categories";

const SETTINGS_CHANGED_EVENT = "open-agent:settings-changed";

export default class OpenAgentPlugin extends Plugin {
	settings: PluginSettings = DEFAULT_SETTINGS;
	sessionStore!: SessionStore;
	private toolRegistry!: ToolRegistry;
	private undo!: UndoBuffer;

	async onload(): Promise<void> {
		const sessionsDir = `${this.manifest.dir}/sessions`;
		let sessionsDirEnsured = false;
		const ensureSessionsDir = async () => {
			if (sessionsDirEnsured) return;
			if (!(await this.app.vault.adapter.exists(sessionsDir))) {
				await this.app.vault.adapter.mkdir(sessionsDir);
			}
			sessionsDirEnsured = true;
		};

		this.sessionStore = new SessionStore({
			persistIndex: async (meta, activeId) => {
				await this.saveData({ ...this.settings, sessions: meta, activeSessionId: activeId });
			},
			readTurns: async (id) => loadStoredTurnsFile({
				adapter: this.app.vault.adapter,
				path: `${sessionsDir}/${id}.json`,
			}),
			writeTurns: async (id, turns) => {
				await ensureSessionsDir();
				await this.app.vault.adapter.write(
					`${sessionsDir}/${id}.json`,
					JSON.stringify({ turns }),
				);
			},
			deleteTurns: async (id) => {
				const path = `${sessionsDir}/${id}.json`;
				if (await this.app.vault.adapter.exists(path)) {
					await this.app.vault.adapter.remove(path);
				}
			},
		});

		await this.loadSettings();
		const recoveryIssues = this.sessionStore.getRecoveryIssues();
		if (recoveryIssues.length === 1) {
			new Notice(recoveryIssues[0].message);
		} else if (recoveryIssues.length > 1) {
			new Notice(`Recovered ${recoveryIssues.length} unreadable chat histories. Open OpenAgent to review the backup locations.`);
		}
		await ensureDefaultPacks(this.app, this.manifest.dir);

		this.toolRegistry = new ToolRegistry();
		this.undo = new UndoBuffer(50);
		this.toolRegistry.registerAll(
			oaAnnotateTools(this.app, [
				openAgentImageGenerateTool(this.app, () => this.settings),
				openAgentImageRegionTool(this.app, "snip"),
				openAgentImageRegionTool(this.app, "blot"),
				...vaultTools(this.app, { undo: this.undo }),
			]),
		);

		this.registerView(CHAT_VIEW_TYPE, (leaf: WorkspaceLeaf) => {
			const consent = new ConsentManager(() => this.settings.consent);
			return new ChatView(leaf, {
				getSettings: () => this.settings,
				openSettings: () => this.openSettings(),
				tools: this.toolRegistry,
				consent,
				undo: this.undo,
				sessionStore: this.sessionStore,
				getPacks: () => this.getPacks(),
				runPack: (pack, query, signal, onEvent) => this.runPack(pack, query, signal, onEvent),
			});
		});

		this.addRibbonIcon("bot", "Open agent", () => this.activateView());

		this.addCommand({
			id: "open-panel",
			name: "Open panel",
			callback: () => this.activateView(),
		});

		this.addCommand({
			id: "ask-about-current-note",
			name: "Ask agent about current note",
			callback: () => this.askAboutCurrentNote(),
		});

		this.addCommand({
			id: "undo-last-tool-write",
			name: "Undo last tool write",
			callback: () => this.undoLastWrite(),
		});

		this.addSettingTab(new OpenAgentSettingsTab(this.app, this));
	}

	onunload(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE)) {
			if (leaf.view instanceof ChatView) leaf.view.cancelInFlight();
		}
	}

	async loadSettings(): Promise<void> {
		const data = (await this.loadData()) as (Partial<PluginSettings> & {
			sessions?: unknown;
			activeSessionId?: unknown;
		}) | null;
		this.settings = {
			...DEFAULT_SETTINGS,
			...(data ?? {}),
			consent: { ...DEFAULT_SETTINGS.consent, ...(data?.consent ?? {}) },
			modelCategories: oaSanitizeModelCategories((data ?? {}).modelCategories),
		};
		const rawSessions = Array.isArray(data?.sessions)
			? (data.sessions as (SessionMeta & { turns?: StoredTurn[] })[])
			: [];
		const activeId = typeof data?.activeSessionId === "string" ? data.activeSessionId : "";
		await this.sessionStore.init(rawSessions, activeId);
	}

	async saveSettings(): Promise<void> {
		await this.saveData({ ...this.settings, ...this.sessionStore.toJSON() });
		window.dispatchEvent(new CustomEvent(SETTINGS_CHANGED_EVENT));
	}

	private async activateView(): Promise<ChatView | null> {
		const { workspace } = this.app;
		const existing = workspace.getLeavesOfType(CHAT_VIEW_TYPE);
		if (existing.length > 0) {
			focusLeaf(workspace, existing[0]);
			return existing[0].view instanceof ChatView ? existing[0].view : null;
		}
		const leaf = Platform.isMobile ? workspace.getLeaf("tab") : workspace.getRightLeaf(false);
		if (!leaf) return null;
		await leaf.setViewState({ type: CHAT_VIEW_TYPE, active: true });
		focusLeaf(workspace, leaf);
		return leaf.view instanceof ChatView ? leaf.view : null;
	}

	private async askAboutCurrentNote(): Promise<void> {
		const file = this.app.workspace.getActiveFile();
		if (!file) {
			new Notice("No active note");
			return;
		}
		const view = await this.activateView();
		if (!view) return;
		view.prefillInput(`Tell me about [[${file.basename}]]`);
	}

	private async undoLastWrite(): Promise<void> {
		const op = this.undo.pop();
		if (!op) {
			new Notice("Nothing to undo");
			return;
		}
		try {
			if ("kind" in op) {
				if (op.kind === "move") {
					const item = this.app.vault.getAbstractFileByPath(op.to);
					if (!(item instanceof TFile) && !(item instanceof TFolder)) {
						throw new Error(`Moved item not found: ${op.to}`);
					}
					if (this.app.vault.getAbstractFileByPath(op.from)) {
						throw new Error(`Original path already exists: ${op.from}`);
					}
					await ensureParentFolder(this.app, op.from);
					await this.app.fileManager.renameFile(item, op.from);
					new Notice(`Reverted ${op.to} to ${op.from}`);
					return;
				}
				if (op.kind === "trash-move") {
					const item = this.app.vault.getAbstractFileByPath(op.to);
					if (!(item instanceof TFile) && !(item instanceof TFolder)) {
						throw new Error(`Trashed item not found: ${op.to}`);
					}
					if (this.app.vault.getAbstractFileByPath(op.from)) {
						throw new Error(`Original path already exists: ${op.from}`);
					}
					await ensureParentFolder(this.app, op.from);
					await this.app.vault.rename(item, op.from);
					new Notice(`Restored ${op.from}`);
					return;
				}
				if (op.kind === "create-folder") {
					const createdPaths = [...op.createdPaths].reverse();
					let removed = 0;
					for (const created of createdPaths) {
						const folder = this.app.vault.getAbstractFileByPath(created);
						if (folder instanceof TFolder && folder.children.length === 0) {
							await this.app.vault.trash(folder, false);
							removed++;
						}
					}
					new Notice(
						removed === createdPaths.length
							? `Removed ${op.path}`
							: `Removed ${removed} empty created folder${removed === 1 ? "" : "s"}; non-empty folders were kept`,
					);
					return;
				}
			}
			const file = this.app.vault.getAbstractFileByPath(op.path);
			if (op.before === null) {
				if (file instanceof TFile) await this.app.vault.trash(file, true);
			} else if (file instanceof TFile) {
				await this.app.vault.modify(file, op.before);
			} else {
				await ensureParentFolder(this.app, op.path);
				await this.app.vault.create(op.path, op.before);
			}
			new Notice(`Reverted ${op.path}`);
		} catch (err) {
			new Notice(`Undo failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	private openSettings(): void {
		const setting = (this.app as unknown as { setting: { open(): void; openTabById(id: string): void } }).setting;
		setting.open();
		setting.openTabById(this.manifest.id);
	}

	private async getPacks(): Promise<AgentPack[]> {
		return loadPacks(this.app, this.manifest.dir);
	}

	private async runPack(
		pack: AgentPack,
		query: string,
		signal?: AbortSignal,
		onEvent?: (event: PackRuntimeEvent) => void | Promise<void>,
	): Promise<PackRunResult> {
		return runPack({
			app: this.app,
			pack,
			query,
			activeFilePath: this.app.workspace.getActiveFile()?.path,
			signal,
			onEvent,
			providerOverrides: this.settings.packProviderOverrides[pack.id],
		});
	}
}

function focusLeaf(workspace: Workspace, leaf: WorkspaceLeaf): void {
	void workspace.revealLeaf(leaf);
}
