import { type App, htmlToMarkdown, ItemView, MarkdownRenderer, Modal, Notice, TFile, WorkspaceLeaf } from "obsidian";
import type { ConsentChoice, ConsentManager } from "./consent/manager";
import type { UndoBuffer } from "./consent/undo";
import { diffLines, type DiffRow } from "./consent/diff";
import { renderRows } from "./consent/render-diff";
import { runTurn } from "./loop";
import { isMobile } from "./platform";
import { OpenAICompatibleProvider, oaFetchModelIds } from "./provider";
import { resolveCitationTarget } from "./citations";
import {
	oaDetectImageMime,
	oaMultimodalContent,
	oaResolveToolImages,
	oaSanitizeImages,
	OA_IMAGE_MIMES,
	OA_MAX_IMAGE_BYTES,
	OA_MAX_IMAGES,
	OA_MAX_TOTAL_IMAGE_BYTES,
	type PendingImage,
} from "./images/attachments";
import { oaBytesToDataUrl, oaDecodeImageToPng, oaImageUrlToPngDataUrl } from "./images/png";
import { oaExtractDisplayedImageEmbeds } from "./images/references";
import { oaPersistInlineModelImage } from "./images/model-images";
import type { ExactPhraseAnchor } from "./agents/verifier";
import { PackConfigError, PackRunError, type PackRuntimeEvent, type PackRunResult, type PackRunTransparency } from "./packs/runtime";
import type { AgentPack } from "./packs/types";
import { isConfigured, type PluginSettings } from "./settings";
import { oaBuildModelOptionGroups } from "./models/categories";
import { oaPaintModelSelect, type ModelSelectPseudoOption } from "./models/selectOptions";
import type {
	SessionMeta,
	SessionStore,
	StoredPackClaim,
	StoredPackProgressStep,
	StoredPackTurnData,
	StoredTurn,
} from "./sessions";
import { splitFrontmatter, mergeFrontmatter, stitchFrontmatter } from "./tools/vault/frontmatter";
import type { ToolRegistry } from "./tools/registry";
import { oaSanitizeGeneratedImages } from "./tools/image-generate";
import { runWithTimeout, ToolTimeoutError, DEFAULT_TOOL_TIMEOUT_MS } from "./tools/timeout";
import { validateArgs } from "./tools/validate";
import { AuthError, type ChatMessage, NetworkError, ProviderError, RateLimitError, type ToolResult, type ConversationImageReference, type GeneratedImage } from "./types";

export const CHAT_VIEW_TYPE = "open-agent-chat";

class ConfirmActionModal extends Modal {
	private resolvePrompt: (confirmed: boolean) => void = () => undefined;
	private decided = false;

	constructor(
		app: App,
		private readonly titleText: string,
		private readonly message: string,
		private readonly confirmText: string,
	) {
		super(app);
	}

	prompt(): Promise<boolean> {
		return new Promise<boolean>((resolve) => {
			this.resolvePrompt = resolve;
			this.open();
		});
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h3", { text: this.titleText });
		contentEl.createEl("p", { text: this.message });

		const buttons = contentEl.createDiv({ cls: "open-agent-edit-buttons" });
		buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.decide(false));
		buttons.createEl("button", { text: this.confirmText, cls: "mod-warning" })
			.addEventListener("click", () => this.decide(true));
	}

	onClose(): void {
		if (!this.decided) this.resolvePrompt(false);
		this.contentEl.empty();
	}

	private decide(confirmed: boolean): void {
		this.decided = true;
		this.resolvePrompt(confirmed);
		this.close();
	}
}

interface ToolCallRecord {
	id: string;
	name: string;
	args: unknown;
	mutates: boolean;
	status: "running" | "awaiting-consent" | "ok" | "error" | "denied";
	result?: ToolResult;
	approvedPending?: boolean;
	diffRows?: DiffRow[]; // undefined = not yet computed; [] = computed, nothing to show
}

type AssistantSegment = { kind: "text"; text: string } | { kind: "tool"; id: string };

interface UiTurn {
	role: "user" | "assistant";
	content: string; // user turns only
	images?: PendingImage[]; // user turns: image attachments sent with the message
	generatedImages?: GeneratedImage[]; // assistant turns: images generated into the vault during the turn
	segments: AssistantSegment[]; // assistant turns: text and tool cards in order
	toolCallMap: Record<string, ToolCallRecord>; // assistant turns: looked up by id
	thinking: boolean; // true until first content arrives
	thinkingLabel?: string; // optional context label shown inside the thinking indicator
	thinkingContent?: string; // model reasoning/thoughts extracted from response
	interrupted?: boolean;
	degraded?: boolean;
	error?: string;
	authError?: boolean;
	capHit?: boolean;
	packTurn?: StoredPackTurnData;
}

export interface ChatViewDeps {
	getSettings: () => PluginSettings;
	openSettings: () => void;
	tools: ToolRegistry;
	consent: ConsentManager;
	undo: UndoBuffer;
	sessionStore: SessionStore;
	getPacks: () => Promise<AgentPack[]>;
	runPack: (
		pack: AgentPack,
		query: string,
		signal?: AbortSignal,
		onEvent?: (event: PackRuntimeEvent) => void | Promise<void>,
	) => Promise<PackRunResult>;
}

export class ChatView extends ItemView {
	private readonly deps: ChatViewDeps;

	private transcriptEl!: HTMLElement;
	private inputEl!: HTMLTextAreaElement;
	private sendBtn!: HTMLButtonElement;
	private stopBtn!: HTMLButtonElement;
	private hintEl!: HTMLElement;

	// Image attachment state (Classic mode)
	private pendingImagesEl!: HTMLElement;
	private imageInputEl!: HTMLInputElement;
	private attachBtn!: HTMLButtonElement;
	private pendingImages: PendingImage[] = [];

	// Header elements
	private headerEl!: HTMLElement;
	private headerBodyEl!: HTMLElement;
	private headerToggleEl!: HTMLButtonElement;
	private headerCollapsed = false;
	private sessionTitleEl!: HTMLElement;
	private sessionRenameEl!: HTMLInputElement;
	private sessionsPanelEl!: HTMLElement;
	private sessionsListEl!: HTMLElement;
	private sessionsSearchEl!: HTMLInputElement;
	private modelInputEl!: HTMLSelectElement;
	private imageModelInputEl!: HTMLSelectElement;
	private imageModelCatalog: string[] = [];
	private textModelCatalog: string[] = [];
	private modeSelectEl!: HTMLSelectElement;
	private packSummaryEl!: HTMLElement;
	private packHintEl!: HTMLElement;
	private packRecoveryEl!: HTMLElement;
	private packMobileBannerEl!: HTMLElement;
	private sessionRecoveryEl!: HTMLElement;

	private turns: UiTurn[] = [];
	private readonly inFlights = new Map<string, AbortController>();
	private readonly stoppingSessions = new Set<string>();
	// Live in-memory turns for sessions currently streaming (so switching back restores them)
	private readonly liveTurns = new Map<string, UiTurn[]>();
	private boundOnSettingsChanged: () => void;
	private readonly diffComputedIds = new Set<string>();

	// Render debounce state
	private renderDebounceTimer: number | null = null;
	private lastRenderTime = 0;

	// Panel state
	private sessionsPanelVisible = false;
	private thinkingHidden = false;
	private availablePacks: AgentPack[] = [];
	private activePackError: string | null = null;
	private readonly packExpandedStepId = new WeakMap<StoredPackTurnData, string | null>();

	// Rename state
	private isRenaming = false;
	private preRenameTitle = "";

	// Edit state
	private editingTurnIndex: number | null = null;
	private editingText = "";

	constructor(leaf: WorkspaceLeaf, deps: ChatViewDeps) {
		super(leaf);
		this.deps = deps;
		this.boundOnSettingsChanged = () => {
			this.refreshConfiguredState();
			void this.populateModelDatalist();
		};
	}

	getViewType(): string {
		return CHAT_VIEW_TYPE;
	}
	getDisplayText(): string {
		return "Open agent";
	}
	getIcon(): string {
		return "bot";
	}

	prefillInput(text: string): void {
		this.inputEl.value = text;
		this.inputEl.focus();
		this.inputEl.setSelectionRange(text.length, text.length);
	}

	handleTranscriptCopy(event: ClipboardEvent): void {
		const selection = this.transcriptEl.ownerDocument.getSelection();
		if (!selection || selection.rangeCount === 0 || selection.isCollapsed || !event.clipboardData) return;

		const range = selection.getRangeAt(0);
		const node = range.commonAncestorContainer;
		const host = node.nodeType === 1 ? node : node.parentElement;
		if (!host || !this.transcriptEl.contains(host)) return;

		const container = this.transcriptEl.ownerDocument.createElement("div");
		container.appendChild(range.cloneContents());

		let markdown: string;
		try {
			markdown = htmlToMarkdown(container).trim();
		} catch {
			return;
		}
		if (!markdown) return;

		try {
			event.clipboardData.setData("text/plain", markdown);
		} catch {
			return;
		}
		try {
			event.clipboardData.setData("text/html", container.innerHTML);
		} catch {
			// Keep the plain-text representation when the HTML write fails.
		}
		event.preventDefault();
	}

	async onOpen(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass("open-agent-view");

		this.hintEl = root.createDiv({ cls: "open-agent-hint" });
		this.buildHeader(root);
		this.transcriptEl = root.createDiv({ cls: "open-agent-transcript" });
		this.transcriptEl.addEventListener("copy", (event) => this.handleTranscriptCopy(event));
		root.addEventListener("dragover", (event) => {
			if (!event.dataTransfer) return;
			const hasImage = Array.from(event.dataTransfer.items).some(
				(item) => item.kind === "file" && item.type.startsWith("image/"),
			);
			if (hasImage) event.preventDefault();
		});
		root.addEventListener("drop", (event) => {
			const files = event.dataTransfer ? Array.from(event.dataTransfer.files) : [];
			const images = files.filter((file) => file.type.startsWith("image/"));
			if (images.length === 0) return;
			event.preventDefault();
			void this.addImageFiles(images);
		});

		const composer = root.createDiv({ cls: "open-agent-composer" });
		this.pendingImagesEl = composer.createDiv({ cls: "open-agent-image-previews" });
		this.inputEl = composer.createEl("textarea", {
			cls: "open-agent-input",
			attr: { rows: "3", placeholder: "Ask the agent…" },
		});
		this.imageInputEl = composer.createEl("input", {
			cls: "open-agent-image-input",
			attr: {
				type: "file",
				accept: "image/png,image/jpeg,image/webp,image/gif",
				multiple: "",
				hidden: "",
			},
		});
		this.imageInputEl.addEventListener("change", () => {
			const files = this.imageInputEl.files ? Array.from(this.imageInputEl.files) : [];
			this.imageInputEl.value = "";
			void this.addImageFiles(files);
		});
		this.inputEl.addEventListener("paste", (event) => {
			const files = event.clipboardData ? Array.from(event.clipboardData.files) : [];
			const images = files.filter((file) => file.type.startsWith("image/"));
			if (images.length === 0) return;
			event.preventDefault();
			void this.addImageFiles(images);
		});
		this.inputEl.addEventListener("keydown", (e) => {
			if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
				e.preventDefault();
				void this.handleSend();
			}
		});

		const buttons = composer.createDiv({ cls: "open-agent-buttons" });
		this.attachBtn = buttons.createEl("button", { text: "Attach images" });
		this.attachBtn.setAttribute("aria-label", "Attach images (vision-capable models only)");
		this.attachBtn.addEventListener("click", () => this.imageInputEl.click());
		this.sendBtn = buttons.createEl("button", { text: "Send", cls: "mod-cta" });
		this.sendBtn.addEventListener("click", () => void this.handleSend());
		this.stopBtn = buttons.createEl("button", { text: "Stop" });
		this.stopBtn.addEventListener("click", () => this.handleStop());
		this.stopBtn.disabled = true;

		window.addEventListener("open-agent:settings-changed", this.boundOnSettingsChanged);

		// Load active session turns
		const session = this.deps.sessionStore.getActive();
		this.turns = await this.storedToUiTurns(session.turns);

		this.refreshConfiguredState();
		void this.populateModelDatalist();
		void this.refreshPacks();
		this.renderTranscript();
		return Promise.resolve();
	}

	onClose(): Promise<void> {
		window.removeEventListener("open-agent:settings-changed", this.boundOnSettingsChanged);
		this.cancelInFlight();
		this.deps.consent.resetSession();
		this.deps.undo.clear();
		return Promise.resolve();
	}

	cancelInFlight(): void {
		for (const ctrl of this.inFlights.values()) ctrl.abort();
		this.inFlights.clear();
	}

	// ─── Header ──────────────────────────────────────────────────────────────

	private buildHeader(root: HTMLElement): void {
		const header = root.createDiv({ cls: "open-agent-header" });
		this.headerEl = header;

		// The toggle button stays visible while the settings body collapses (I8).
		this.headerToggleEl = header.createEl("button", {
			cls: "open-agent-header-toggle",
			text: "▾ Hide chat controls",
			attr: { "aria-label": "Collapse chat controls", "aria-expanded": "true" },
		});
		this.headerToggleEl.addEventListener("click", () => this.toggleHeaderCollapsed());
		const body = header.createDiv({ cls: "open-agent-header-body" });
		this.headerBodyEl = body;

		// Session bar
		const sessionBar = body.createDiv({ cls: "open-agent-session-bar" });

		// Clickable title → inline rename
		this.sessionTitleEl = sessionBar.createEl("span", { cls: "open-agent-session-title" });
		this.sessionTitleEl.addEventListener("click", () => this.startRename());

		// Rename input (hidden by default)
		this.sessionRenameEl = sessionBar.createEl("input", {
			cls: "open-agent-session-rename",
			attr: { type: "text" },
		});
		this.sessionRenameEl.addClass("is-hidden");
		this.sessionRenameEl.addEventListener("keydown", (e) => {
			if (e.key === "Enter") this.finishRename();
			if (e.key === "Escape") this.cancelRename();
		});
		this.sessionRenameEl.addEventListener("blur", () => this.finishRename());

		// Sessions toggle button
		const sessionsToggle = sessionBar.createEl("button", { text: "≡", cls: "open-agent-sessions-toggle" });
		sessionsToggle.setAttribute("aria-label", "Browse sessions");
		sessionsToggle.addEventListener("click", () => this.toggleSessionsPanel());

		// New session button
		const newBtn = sessionBar.createEl("button", { text: "+ New", cls: "open-agent-session-new" });
		newBtn.addEventListener("click", () => { void this.createSession(); });

		// Delete session button
		const deleteBtn = sessionBar.createEl("button", { text: "Delete", cls: "open-agent-session-delete" });
		deleteBtn.addEventListener("click", () => { void this.deleteActiveSession(); });

		// Sessions panel (hidden by default)
		this.sessionsPanelEl = body.createDiv({ cls: "open-agent-sessions-panel" });
		this.sessionsPanelEl.addClass("is-hidden");

		this.sessionsSearchEl = this.sessionsPanelEl.createEl("input", {
			cls: "open-agent-sessions-search",
			attr: { type: "text", placeholder: "Search sessions…" },
		});
		this.sessionsSearchEl.addEventListener("input", () => {
			this.refreshSessionsList(this.sessionsSearchEl.value);
		});

		this.sessionsListEl = this.sessionsPanelEl.createDiv({ cls: "open-agent-sessions-list" });

		const modeBar = body.createDiv({ cls: "open-agent-mode-bar" });
		modeBar.createEl("span", { text: "Mode:", cls: "open-agent-model-label" });
		this.modeSelectEl = modeBar.createEl("select", { cls: "open-agent-mode-select" });
		this.modeSelectEl.addEventListener("change", () => { void this.handleModeChange(); });

		// Model bar
		const modelBar = body.createDiv({ cls: "open-agent-model-bar" });
		modelBar.createEl("span", { text: "Model:", cls: "open-agent-model-label" });

		this.modelInputEl = modelBar.createEl("select", { cls: "open-agent-model-input" });
		this.modelInputEl.addEventListener("change", () => { void this.handleModelChange(); });

		// Image model bar
		const imageModelBar = body.createDiv({ cls: "open-agent-model-bar" });
		imageModelBar.createEl("span", { text: "Image:", cls: "open-agent-model-label" });
		this.imageModelInputEl = imageModelBar.createEl("select", { cls: "open-agent-model-input" });
		this.imageModelInputEl.addEventListener("change", () => { void this.handleImageModelChange(); });

		this.packSummaryEl = body.createDiv({ cls: "open-agent-pack-summary" });
		this.packHintEl = body.createDiv({ cls: "open-agent-pack-hint", text: "Applies to future turns in this chat." });
		this.packRecoveryEl = body.createDiv({ cls: "open-agent-pack-recovery" });
		this.packMobileBannerEl = body.createDiv({ cls: "open-agent-pack-mobile-banner" });
		this.sessionRecoveryEl = body.createDiv({ cls: "open-agent-session-recovery" });

		this.refreshHeader();
	}

	private toggleHeaderCollapsed(): void {
		this.headerCollapsed = !this.headerCollapsed;
		this.headerBodyEl.classList.toggle("is-hidden", this.headerCollapsed);
		this.headerEl.classList.toggle("is-collapsed", this.headerCollapsed);
		this.headerToggleEl.setAttribute("aria-expanded", this.headerCollapsed ? "false" : "true");
		this.headerToggleEl.setAttribute(
			"aria-label",
			this.headerCollapsed ? "Expand chat controls" : "Collapse chat controls",
		);
		this.headerToggleEl.setText(this.headerCollapsed ? "▸ Show chat controls" : "▾ Hide chat controls");
	}

	private refreshHeader(): void {
		const active = this.deps.sessionStore.getActive();
		const settings = this.deps.getSettings();
		this.sessionTitleEl.setText(active.title);
		this.refreshTextModelOptions(active, settings);
		this.refreshImageModelOptions(active, settings);

		this.modeSelectEl.empty();
		this.modeSelectEl.createEl("option", { value: "", text: "Classic" });
		for (const pack of this.getSelectablePacks()) {
			this.modeSelectEl.createEl("option", { value: pack.id, text: pack.name });
		}
		this.modeSelectEl.value = active.selectedPackId ?? "";

		const activePack = this.getActivePack();
		const packMode = Boolean(active.selectedPackId);
		const mobileBlocked = packMode && this.isMobileBlockedPack();
		const sessionRecovery = active.recovery;
		this.packSummaryEl.empty();
		this.packRecoveryEl.empty();
		this.packMobileBannerEl.empty();
		this.sessionRecoveryEl.empty();

		if (this.modelInputEl.parentElement) {
			this.modelInputEl.parentElement.classList.toggle("is-hidden", packMode);
		}
		if (this.imageModelInputEl.parentElement) {
			this.imageModelInputEl.parentElement.classList.toggle("is-hidden", packMode);
		}
		this.packSummaryEl.classList.toggle("is-hidden", !packMode);
		this.packHintEl.classList.toggle("is-hidden", !packMode);

		if (activePack) {
			const overrides = settings.packProviderOverrides[activePack.id] ?? {};
			const effectiveModel = (providerName: string): string => {
				return overrides[providerName]?.model?.trim() || activePack.providers[providerName]?.model || "n/a";
			};
			this.packSummaryEl.createEl("div", { cls: "open-agent-pack-name", text: activePack.name });
			this.packSummaryEl.createEl("div", {
				cls: "open-agent-pack-models",
				text:
					`Retriever — ${effectiveModel("retriever")}; ` +
					`Synthesizer — ${effectiveModel("synthesizer")}; ` +
					`Verifier — ${effectiveModel("verifier")}`,
			});
		}

		if (mobileBlocked) {
			this.packMobileBannerEl.createEl("div", {
				cls: "open-agent-pack-banner",
				text: "Grounded Research is available on desktop only for now.",
			});
			const classicBtn = this.packMobileBannerEl.createEl("button", { text: "Use Classic mode" });
			classicBtn.addEventListener("click", () => {
				void this.switchToClassicMode();
			});
		}

		if (this.activePackError) {
			this.packRecoveryEl.createEl("div", { cls: "open-agent-pack-banner open-agent-pack-banner-error", text: this.activePackError });
			const classicBtn = this.packRecoveryEl.createEl("button", { text: "Use Classic mode" });
			classicBtn.addEventListener("click", () => {
				void this.switchToClassicMode();
			});
			if (this.getSelectablePacks().length > 0) {
				const chooseBtn = this.packRecoveryEl.createEl("button", { text: "Choose another pack" });
				chooseBtn.addEventListener("click", () => {
					this.modeSelectEl.focus();
				});
			}
		}

		if (sessionRecovery) {
			this.sessionRecoveryEl.createEl("div", {
				cls: "open-agent-pack-banner open-agent-pack-banner-error",
				text: sessionRecovery.message,
			});
		}
	}

	private async createSession(): Promise<void> {
		await this.deps.sessionStore.create();
		this.turns = [];
		this.pendingImages = [];
		this.renderPendingImages();
		this.deps.undo.clear();
		this.refreshHeader();
		this.renderTranscript();
	}

	private async deleteActiveSession(): Promise<void> {
		const confirmed = await new ConfirmActionModal(
			this.app,
			"Delete session?",
			"This will permanently remove the current session history.",
			"Delete",
		).prompt();
		if (!confirmed) return;
		const id = this.deps.sessionStore.getActive().id;
		await this.deps.sessionStore.delete(id);
		const session = this.deps.sessionStore.getActive();
		this.turns = await this.storedToUiTurns(session.turns);
		this.pendingImages = [];
		this.renderPendingImages();
		this.deps.undo.clear();
		this.refreshHeader();
		this.renderTranscript();
	}

	private async handleModeChange(): Promise<void> {
		const session = this.deps.sessionStore.getActive();
		const nextPackId = this.modeSelectEl.value || null;
		const currentClassicModel = this.modelInputEl.value.trim() || session.lastClassicModel || session.model;
		this.activePackError = null;
		await this.deps.sessionStore.updateSelectedPack(session.id, nextPackId, currentClassicModel);
		this.refreshHeader();
		this.refreshConfiguredState();
	}

	private async handleModelChange(): Promise<void> {
		const model = this.modelInputEl.value;
		const session = this.deps.sessionStore.getActive();
		await this.deps.sessionStore.updateModel(session.id, model);
	}

	private getSessionTextOverride(
		session: SessionMeta = this.deps.sessionStore.getActive(),
		settings: PluginSettings = this.deps.getSettings(),
	): string {
		if (typeof session.textModel === "string") return session.textModel.trim();
		const candidate = session.lastClassicModel?.trim() || session.model?.trim() || "";
		return candidate && candidate !== settings.model?.trim() ? candidate : "";
	}

	private refreshTextModelOptions(
		session: SessionMeta = this.deps.sessionStore.getActive(),
		settings: PluginSettings = this.deps.getSettings(),
	): void {
		if (!this.modelInputEl) return;
		let selected = this.getSessionTextOverride(session, settings);
		let global = settings.model?.trim() ?? "";
		if (this.textModelCatalog.length > 0) {
			if (!this.textModelCatalog.includes(selected)) selected = "";
			if (!this.textModelCatalog.includes(global)) global = "";
		}
		const pseudo: ModelSelectPseudoOption[] = [
			{ label: global ? `Default: ${global}` : "Default: not configured", value: "" },
		];
		if (selected) pseudo.push({ label: selected, value: selected });
		if (global && global !== selected) pseudo.push({ label: global, value: global });
		oaPaintModelSelect(
			this.modelInputEl,
			pseudo,
			oaBuildModelOptionGroups(this.textModelCatalog, settings.modelCategories),
		);
		this.modelInputEl.value = selected;
	}

	private async handleImageModelChange(): Promise<void> {
		const value = this.imageModelInputEl.value;
		const session = this.deps.sessionStore.getActive();
		await this.deps.sessionStore.updateImageModel(session.id, value);
	}

	private refreshImageModelOptions(
		session: SessionMeta = this.deps.sessionStore.getActive(),
		settings: PluginSettings = this.deps.getSettings(),
	): void {
		if (!this.imageModelInputEl) return;
		let selected = session.imageModel?.trim() ?? "";
		let global = settings.imageModel?.trim() ?? "";
		if (this.imageModelCatalog.length > 0) {
			if (!this.imageModelCatalog.includes(selected)) selected = "";
			if (!this.imageModelCatalog.includes(global)) global = "";
		}
		const pseudo: ModelSelectPseudoOption[] = [
			{ label: global ? `Default: ${global}` : "Default: not configured", value: "" },
		];
		if (selected) pseudo.push({ label: selected, value: selected });
		if (global && global !== selected) pseudo.push({ label: global, value: global });
		oaPaintModelSelect(
			this.imageModelInputEl,
			pseudo,
			oaBuildModelOptionGroups(this.imageModelCatalog, settings.modelCategories),
		);
		this.imageModelInputEl.value = selected;
	}

	private async refreshPacks(): Promise<void> {
		try {
			this.availablePacks = await this.deps.getPacks();
		} catch (error) {
			this.availablePacks = [];
			this.activePackError = error instanceof Error ? error.message : String(error);
		}
		this.refreshHeader();
		this.refreshConfiguredState();
	}

	private getSelectablePacks(): AgentPack[] {
		return this.availablePacks.filter((pack) => !isMobile() || pack.support.mobile);
	}

	private getActivePack(): AgentPack | null {
		const selectedPackId = this.deps.sessionStore.getActive().selectedPackId;
		if (!selectedPackId) return null;
		return this.availablePacks.find((pack) => pack.id === selectedPackId) ?? null;
	}

	private isMobileBlockedPack(): boolean {
		const activePack = this.getActivePack();
		return Boolean(activePack && isMobile() && !activePack.support.mobile);
	}

	private async switchToClassicMode(): Promise<void> {
		const session = this.deps.sessionStore.getActive();
		await this.deps.sessionStore.updateSelectedPack(
			session.id,
			null,
			this.modelInputEl.value.trim() || session.lastClassicModel || session.model,
		);
		this.activePackError = null;
		this.refreshHeader();
		this.refreshConfiguredState();
	}

	private toggleSessionsPanel(): void {
		this.setSessionsPanelVisible(!this.sessionsPanelVisible);
		if (this.sessionsPanelVisible) {
			this.sessionsSearchEl.value = "";
			this.refreshSessionsList("");
			this.sessionsSearchEl.focus();
		}
	}

	private setSessionsPanelVisible(visible: boolean): void {
		this.sessionsPanelVisible = visible;
		this.sessionsPanelEl.classList.toggle("is-hidden", !visible);
	}

	private refreshSessionsList(filter: string): void {
		this.sessionsListEl.empty();
		const sessions = this.deps.sessionStore.getSessions()
			.slice()
			.sort((a, b) => b.updatedAt - a.updatedAt);
		const q = filter.trim().toLowerCase();
		const filtered = q ? sessions.filter((s) => s.title.toLowerCase().includes(q)) : sessions;
		const activeId = this.deps.sessionStore.getActive().id;

		for (const s of filtered) {
			const isBusySession = this.inFlights.has(s.id);
			const item = this.sessionsListEl.createDiv({
				cls: "open-agent-session-item" +
					(s.id === activeId ? " open-agent-session-item-active" : "") +
					(isBusySession ? " open-agent-session-item-busy" : ""),
			});
			item.createEl("span", { text: s.title, cls: "open-agent-session-item-title" });
			if (isBusySession) {
				item.createEl("span", { cls: "open-agent-session-activity" });
			}
			item.addEventListener("click", () => { void this.switchToSession(s.id); });
		}

		if (filtered.length === 0) {
			this.sessionsListEl.createDiv({ cls: "open-agent-sessions-empty", text: "No sessions found" });
		}
	}

	private startRename(): void {
		if (this.isRenaming) return;
		const session = this.deps.sessionStore.getActive();
		this.preRenameTitle = session.title;
		this.sessionRenameEl.value = session.title;
		this.setRenameMode(true);
		this.sessionRenameEl.focus();
		this.sessionRenameEl.select();
	}

	private finishRename(): void {
		if (!this.isRenaming) return;
		const newTitle = this.sessionRenameEl.value.trim();
		const session = this.deps.sessionStore.getActive();
		const title = newTitle.length > 0 ? newTitle : this.preRenameTitle;
		this.sessionTitleEl.setText(title);
		this.setRenameMode(false);
		if (title !== session.title) {
			void this.deps.sessionStore.rename(session.id, title);
		}
	}

	private cancelRename(): void {
		if (!this.isRenaming) return;
		this.sessionRenameEl.value = this.preRenameTitle;
		this.setRenameMode(false);
	}

	private setRenameMode(enabled: boolean): void {
		this.isRenaming = enabled;
		this.sessionTitleEl.classList.toggle("is-hidden", enabled);
		this.sessionRenameEl.classList.toggle("is-hidden", !enabled);
	}

	private async switchToSession(sessionId: string): Promise<void> {
		this.setSessionsPanelVisible(false);
		await this.deps.sessionStore.switchTo(sessionId);
		const session = this.deps.sessionStore.getActive();
		// Prefer live in-memory turns (stream still running) over stale stored state
		this.turns = this.liveTurns.get(sessionId) ?? (await this.storedToUiTurns(session.turns));
		this.pendingImages = [];
		this.renderPendingImages();
		this.deps.undo.clear();
		this.refreshHeader();
		this.refreshBusyState();
		this.renderTranscript();
	}

	private async populateModelDatalist(): Promise<void> {
		const settings = this.deps.getSettings();
		if (!isConfigured(settings)) return;
		const provider = new OpenAICompatibleProvider({
			baseUrl: settings.baseUrl,
			apiKey: settings.apiKey,
			model: settings.model,
		});
		const [models, imageModels] = await Promise.all([
			provider.listModels(),
			oaFetchModelIds(settings.baseUrl, settings.apiKey, "image"),
		]);
		if (models.length > 0) {
			this.textModelCatalog = models;
			this.refreshTextModelOptions();
		}
		if (imageModels.length > 0) this.imageModelCatalog = imageModels;
		this.refreshImageModelOptions();
	}

	// ─── Render debounce ─────────────────────────────────────────────────────

	private scheduleRender(): void {
		const now = Date.now();
		const elapsed = now - this.lastRenderTime;
		if (elapsed >= 50) {
			this.lastRenderTime = now;
			this.renderTranscript();
			return;
		}
		if (this.renderDebounceTimer !== null) return;
		this.renderDebounceTimer = window.setTimeout(() => {
			this.renderDebounceTimer = null;
			this.lastRenderTime = Date.now();
			this.renderTranscript();
		}, 50 - elapsed);
	}

	// ─── Session helpers ──────────────────────────────────────────────────────

	private async storedToUiTurns(stored: StoredTurn[]): Promise<UiTurn[]> {
		return Promise.all(
			stored.map(async (st) => {
				if (st.role === "user") {
					return {
						role: "user",
						content: st.content,
						images: await this.normalizeConversationImagesToPng(oaSanitizeImages(st.images)),
						segments: [],
						toolCallMap: {},
						thinking: false,
					} as UiTurn;
				}
				if (st.packTurn) {
					return {
						role: "assistant",
						content: "",
						segments: [],
						toolCallMap: {},
						thinking: false,
						packTurn: st.packTurn,
						error: st.packTurn.error,
						generatedImages: oaSanitizeGeneratedImages(st.generatedImages),
					} as UiTurn;
				}
				return {
					role: "assistant",
					content: "",
					segments: [{ kind: "text" as const, text: st.content }],
					toolCallMap: {},
					thinking: false,
					generatedImages: oaSanitizeGeneratedImages(st.generatedImages),
				} as UiTurn;
			}),
		);
	}

	private uiToStoredTurns(turns: UiTurn[]): StoredTurn[] {
		const result: StoredTurn[] = [];
		for (const t of turns) {
			if (t.role === "user" && (t.content.length > 0 || (t.images?.length ?? 0) > 0)) {
				result.push({
					role: "user",
					content: t.content,
					...(t.images?.length ? { images: t.images } : {}),
				});
			} else if (t.role === "assistant") {
				const generatedImages = t.generatedImages?.length
					? { generatedImages: t.generatedImages }
					: {};
				if (t.packTurn) {
					result.push({ role: "assistant", content: "", packTurn: t.packTurn, ...generatedImages });
					continue;
				}
				const text = t.segments
					.filter((s): s is { kind: "text"; text: string } => s.kind === "text")
					.map((s) => s.text)
					.join("");
				if (text.length > 0 || t.generatedImages?.length) {
					result.push({ role: "assistant", content: text, ...generatedImages });
				}
			}
		}
		return result;
	}

	private getConversationImages(turns: UiTurn[] = this.turns): ConversationImageReference[] {
		const list: ConversationImageReference[] = [];
		for (const turn of turns) {
			if (turn.role === "user") {
				for (const image of turn.images ?? []) {
					if (typeof image.url === "string") list.push({ url: image.url, name: image.name });
				}
			} else {
				for (const image of turn.generatedImages ?? []) {
					list.push({ path: image.path, name: image.path });
				}
				if (turn.role === "assistant") {
					const text = turn.segments
						.filter((segment) => segment.kind === "text")
						.map((segment) => segment.text)
						.join("");
					for (const target of oaExtractDisplayedImageEmbeds(text)) {
						list.push({ path: target, name: target });
					}
				}
			}
		}
		return list.slice(-OA_MAX_IMAGES);
	}

	// ─── Configured / busy state ──────────────────────────────────────────────

	private refreshConfiguredState(): void {
		this.hintEl.empty();
		const classicConfigured = isConfigured(this.deps.getSettings());
		const packMode = Boolean(this.deps.sessionStore.getActive().selectedPackId);
		if (!packMode && !classicConfigured) {
			this.hintEl.appendText("Provider not configured. ");
			const link = this.hintEl.createEl("a", { text: "Open settings", href: "#" });
			link.addEventListener("click", (e) => {
				e.preventDefault();
				this.deps.openSettings();
			});
		}
		if (this.modelInputEl) this.refreshHeader();
		this.refreshBusyState();
	}

	private refreshBusyState(): void {
		const activeId = this.deps.sessionStore.getActive().id;
		const busy = this.inFlights.has(activeId);
		const stopping = this.stoppingSessions.has(activeId);
		const packMode = Boolean(this.deps.sessionStore.getActive().selectedPackId);
		const activePack = this.getActivePack();
		const classicOk = isConfigured(this.deps.getSettings());
		const packOk = packMode ? Boolean(activePack) && !this.isMobileBlockedPack() : false;
		this.sendBtn.disabled = !(packMode ? packOk : classicOk) || busy;
		this.stopBtn.disabled = !busy || stopping;
		this.inputEl.disabled = busy;
		if (this.attachBtn) this.attachBtn.disabled = busy || packMode;
		if (this.imageInputEl) this.imageInputEl.disabled = busy || packMode;
		this.sendBtn.textContent = packMode ? "Run research" : "Send";
		this.stopBtn.textContent = stopping ? "Stopping..." : "Stop";
		if (this.sessionsPanelVisible) {
			this.refreshSessionsList(this.sessionsSearchEl.value);
		}
	}

	// ─── Send / stop ──────────────────────────────────────────────────────────

	private async handleSend(): Promise<void> {
		if (this.deps.sessionStore.getActive().selectedPackId) {
			await this.handlePackSend();
			return;
		}
		await this.handleClassicSend();
	}

	private async handleClassicSend(): Promise<void> {
		const text = this.inputEl.value.trim();
		const images = [...this.pendingImages];
		if (!text && images.length === 0) return;
		const settings = this.deps.getSettings();
		if (!isConfigured(settings)) {
			this.refreshConfiguredState();
			return;
		}

		const session = this.deps.sessionStore.getActive();
		const sessionId = session.id;
		const imageModel =
			this.imageModelInputEl.value.trim() ||
			(this.imageModelCatalog.length === 0 || this.imageModelCatalog.includes(settings.imageModel?.trim())
				? settings.imageModel?.trim()
				: "") ||
			"";
		const isFirstMessage = session.turns.length === 0 && session.title === "New chat";

		this.turns.push({
			role: "user",
			content: text,
			images: images.length > 0 ? images : undefined,
			segments: [],
			toolCallMap: {},
			thinking: false,
		});
		const assistantTurn: UiTurn = { role: "assistant", content: "", segments: [], toolCallMap: {}, thinking: true, generatedImages: [] };
		this.turns.push(assistantTurn);
		// Snapshot the turns array reference so the finally block always saves to the right session
		// even if this.turns is replaced by a session switch mid-flight.
		const turnSnapshot = this.turns;
		this.inputEl.value = "";
		this.pendingImages = [];
		this.renderPendingImages();

		// Mark session busy immediately — before any awaits — so the input is disabled and
		// a second Send press cannot race with the in-progress request.
		const ctrl = new AbortController();
		this.stoppingSessions.delete(sessionId);
		this.inFlights.set(sessionId, ctrl);
		this.liveTurns.set(sessionId, turnSnapshot);
		this.refreshBusyState();
		this.renderTranscript();

		// Read model directly from input element to catch values not yet flushed via change event.
		const inputModel = this.modelInputEl.value.trim();
		const sessionModel = this.getSessionTextOverride(session, settings);
		const model = inputModel || settings.model;

		// Fire-and-forget housekeeping that runs before the loop but doesn't block the busy state.
		if (isFirstMessage) {
			const titleText = text || images.map((image) => image.name).join(", ");
			await this.deps.sessionStore.rename(sessionId, titleText.slice(0, 60));
			this.refreshHeader();
		}
		if (inputModel !== sessionModel) {
			await this.deps.sessionStore.updateModel(sessionId, inputModel);
		}

		const provider = new OpenAICompatibleProvider({
			baseUrl: settings.baseUrl,
			apiKey: settings.apiKey,
			model,
		});

		// Build the message history from prior user/assistant exchanges (skip the placeholder assistantTurn).
		const messages: ChatMessage[] = [];
		for (const t of turnSnapshot) {
			if (t === assistantTurn) continue;
			if (t.role === "user") {
				messages.push({ role: "user", content: oaMultimodalContent(t.content, t.images) });
			} else if (t.role === "assistant") {
				const assistantText = t.segments
					.filter((s): s is { kind: "text"; text: string } => s.kind === "text")
					.map((s) => s.text)
					.join("");
				const generatedImages = t.generatedImages ?? [];
				const content =
					assistantText +
					(generatedImages.length > 0
						? `${assistantText ? "\n\n" : ""}Images shown in chat and available in the vault:\n${generatedImages.map((i) => `- ${i.path}`).join("\n")}`
						: "");
				if (content.length > 0) messages.push({ role: "assistant", content });
			}
		}

		// Persist the user message immediately so switching back to this session
		// shows the question even while the stream is still in-flight.
		await this.deps.sessionStore.updateTurns(
			sessionId,
			this.uiToStoredTurns(turnSnapshot.filter((t) => t !== assistantTurn)),
		);

		try {
			for await (const ev of runTurn(messages, provider, {
				signal: ctrl.signal,
				systemPrompt: settings.systemPrompt,
				tools: this.deps.tools,
				consent: this.deps.consent,
				resolveToolImages: (_name, result) => oaResolveToolImages(this.app, result),
				getConversationImages: () => this.getConversationImages(turnSnapshot),
				getImageModel: () => imageModel,
			})) {
				if (ev.kind === "thinking_text") {
					assistantTurn.thinkingContent = (assistantTurn.thinkingContent ?? "") + ev.text;
					if (this.turns.includes(assistantTurn)) this.scheduleRender();
					continue;
				} else if (ev.kind === "text") {
					if (ev.degraded) assistantTurn.degraded = true;
					assistantTurn.thinking = false;
					assistantTurn.thinkingLabel = undefined;
					const lastSeg = assistantTurn.segments[assistantTurn.segments.length - 1];
					if (lastSeg?.kind === "text") {
						lastSeg.text += ev.text;
					} else {
						assistantTurn.segments.push({ kind: "text", text: ev.text });
					}
					// Only update the UI if the user is still viewing this session's turns.
					if (this.turns.includes(assistantTurn)) this.scheduleRender();
					// Yield to the browser so it can repaint between token chunks.
					await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
					continue;
				} else if (ev.kind === "images") {
					assistantTurn.thinking = false;
					for (const url of ev.urls) {
						try {
							const image = await oaPersistInlineModelImage(this.app, url, text, model);
							const list = assistantTurn.generatedImages ?? (assistantTurn.generatedImages = []);
							if (!list.some((i) => i.path === image.path)) list.push(image);
						} catch (err) {
							assistantTurn.error = `Could not save model image: ${err instanceof Error ? err.message : String(err)}`;
						}
					}
					await this.deps.sessionStore.updateTurns(sessionId, this.uiToStoredTurns(turnSnapshot));
					if (this.turns.includes(assistantTurn)) this.scheduleRender();
					continue;
				} else if (ev.kind === "tool_call_started") {
					assistantTurn.thinking = false;
					const record: ToolCallRecord = {
						id: ev.id,
						name: ev.name,
						args: ev.args,
						mutates: ev.mutates,
						status: "running",
					};
					assistantTurn.toolCallMap[ev.id] = record;
					assistantTurn.segments.push({ kind: "tool", id: ev.id });
				} else if (ev.kind === "consent_requested") {
					const tc = assistantTurn.toolCallMap[ev.id];
					if (tc) tc.status = "awaiting-consent";
				} else if (ev.kind === "tool_call_finished") {
					const tc = assistantTurn.toolCallMap[ev.id];
					if (tc) {
						tc.result = ev.result;
						if (ev.result.ok) tc.status = "ok";
						else if (ev.result.error.startsWith("ConsentDeniedError")) tc.status = "denied";
						else tc.status = "error";
					}
					if (tc?.name === "image_generate" && ev.result.ok) {
						const value = ev.result.value as {
							path?: unknown;
							prompt?: unknown;
							model?: unknown;
							referenceImageNames?: unknown;
						} | null;
						if (value && typeof value === "object" && typeof value.path === "string") {
							const list = assistantTurn.generatedImages ?? (assistantTurn.generatedImages = []);
							if (!list.some((i) => i.path === value.path)) {
								list.push({
									path: value.path,
									prompt: typeof value.prompt === "string" ? value.prompt : "",
									model: typeof value.model === "string" ? value.model : "",
									referenceImageNames: Array.isArray(value.referenceImageNames)
										? value.referenceImageNames
										: [],
								});
							}
							await this.deps.sessionStore.updateTurns(sessionId, this.uiToStoredTurns(turnSnapshot));
						}
					}
					if (tc?.name === "vault_image" && ev.result.ok) {
						const value = ev.result.value as { path?: unknown; displayInChat?: unknown } | null;
						if (value && typeof value === "object" && value.displayInChat === true && typeof value.path === "string") {
							const list = assistantTurn.generatedImages ?? (assistantTurn.generatedImages = []);
							if (!list.some((i) => i.path === value.path)) {
								list.push({ path: value.path, prompt: "", model: "", source: "vault" });
							}
							await this.deps.sessionStore.updateTurns(sessionId, this.uiToStoredTurns(turnSnapshot));
						}
					}
					// Show thinking indicator while the model processes tool results.
					assistantTurn.thinking = !(tc?.name === "image_generate" && !ev.result.ok);
					assistantTurn.thinkingLabel =
						assistantTurn.thinking && tc ? `Processing ${tc.name}…` : undefined;
				} else if (ev.kind === "cap_hit") {
					assistantTurn.capHit = true;
				}
				if (this.turns.includes(assistantTurn)) this.scheduleRender();
			}
		} catch (err) {
			this.applyErrorToTurn(assistantTurn, err);
		} finally {
			if (this.renderDebounceTimer !== null) {
				window.clearTimeout(this.renderDebounceTimer);
				this.renderDebounceTimer = null;
			}
			if (ctrl.signal.aborted) {
				assistantTurn.interrupted = true;
				this.deps.consent.cancelPendingConsent();
			}
			this.inFlights.delete(sessionId);
			this.liveTurns.delete(sessionId);
			this.refreshBusyState();
			// Only re-render if the user is still viewing this session; otherwise leave the
			// active session's transcript undisturbed.
			if (this.turns.includes(assistantTurn)) this.renderTranscript();
			// Always persist — uses turnSnapshot so session switches don't corrupt the wrong session.
			await this.deps.sessionStore.updateTurns(sessionId, this.uiToStoredTurns(turnSnapshot));
		}
	}

	private async handlePackSend(): Promise<void> {
		if (this.pendingImages.length > 0) {
			new Notice("Image attachments are available in Classic mode. Remove them or switch modes.");
			return;
		}
		const text = this.inputEl.value.trim();
		if (!text) return;
		const pack = this.getActivePack();
		if (!pack) {
			this.activePackError = "Selected pack could not be loaded. Choose another pack or use Classic mode.";
			this.refreshHeader();
			this.refreshBusyState();
			return;
		}
		if (this.isMobileBlockedPack()) {
			this.refreshHeader();
			this.refreshBusyState();
			return;
		}

		const session = this.deps.sessionStore.getActive();
		const sessionId = session.id;
		const isFirstMessage = session.turns.length === 0 && session.title === "New chat";
		this.activePackError = null;

		this.turns.push({ role: "user", content: text, segments: [], toolCallMap: {}, thinking: false });
		const assistantTurn: UiTurn = {
			role: "assistant",
			content: "",
			segments: [],
			toolCallMap: {},
			thinking: false,
			packTurn: {
				packId: pack.id,
				packName: pack.name,
				progressSteps: pack.steps.map((step) => ({
					id: step.id,
					label: step.label,
					state: "pending",
				})),
				retryingStepId: null,
			},
		};
		this.turns.push(assistantTurn);
		const turnSnapshot = this.turns;
		this.inputEl.value = "";

		const ctrl = new AbortController();
		this.inFlights.set(sessionId, ctrl);
		this.liveTurns.set(sessionId, turnSnapshot);
		this.refreshBusyState();
		this.renderTranscript();

		if (isFirstMessage) {
			await this.deps.sessionStore.rename(sessionId, text.slice(0, 60));
			this.refreshHeader();
		}

		await this.deps.sessionStore.updateTurns(
			sessionId,
			this.uiToStoredTurns(turnSnapshot.filter((turn) => turn !== assistantTurn)),
		);

		try {
			const result = await this.deps.runPack(pack, text, ctrl.signal, async (event) => {
				if (!assistantTurn.packTurn) return;
				this.applyPackEvent(assistantTurn.packTurn, event);
				if (this.turns.includes(assistantTurn)) this.scheduleRender();
			});
			if (assistantTurn.packTurn) {
				assistantTurn.packTurn.verifiedSummary = result.verifiedSummary;
				assistantTurn.packTurn.researchMarkdown = result.researchMarkdown;
				assistantTurn.packTurn.citations = result.citations;
				assistantTurn.packTurn.claims = result.claims.map((claim) => ({
					id: claim.id,
					text: claim.text,
					sourceNote: claim.sourceNote,
					sourceQuote: claim.sourceQuote,
					quotePresent: claim.quotePresent,
					supportsClaim: claim.supportsClaim,
					supportExplanation: claim.supportExplanation,
					status: claim.status,
					exactPhraseAnchor: claim.exactPhraseAnchor,
				}));
				assistantTurn.packTurn.agentWork = result.transparency;
				assistantTurn.packTurn.modelsUsed = result.modelsUsed;
				assistantTurn.error = undefined;
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const interrupted = ctrl.signal.aborted;
			if (assistantTurn.packTurn) {
				if (error instanceof PackRunError) {
					assistantTurn.packTurn.agentWork = error.failure.transparency;
					assistantTurn.packTurn.modelsUsed = error.failure.modelsUsed;
					if (error.failure.artifacts.verifications) {
						assistantTurn.packTurn.claims = error.failure.artifacts.verifications.map((claim) => ({
							id: claim.id,
							text: claim.text,
							sourceNote: claim.sourceNote,
							sourceQuote: claim.sourceQuote,
							quotePresent: claim.quotePresent,
							supportsClaim: claim.supportsClaim,
							supportExplanation: claim.supportExplanation,
							status: claim.status,
							exactPhraseAnchor: claim.exactPhraseAnchor,
						}));
					}
				}
				if (interrupted) {
					assistantTurn.packTurn.error = undefined;
					markPackStopped(assistantTurn.packTurn.progressSteps ?? []);
				} else {
					assistantTurn.packTurn.error = message;
					markPackFailed(assistantTurn.packTurn.progressSteps ?? []);
				}
			}
			if (interrupted) {
				assistantTurn.error = undefined;
				this.activePackError = null;
			} else {
				assistantTurn.error = message;
				this.activePackError = this.formatPackRecoveryMessage(pack.name, error);
				this.refreshHeader();
			}
		} finally {
			if (this.renderDebounceTimer !== null) {
				window.clearTimeout(this.renderDebounceTimer);
				this.renderDebounceTimer = null;
			}
			if (ctrl.signal.aborted) {
				assistantTurn.interrupted = true;
			}
			this.stoppingSessions.delete(sessionId);
			this.inFlights.delete(sessionId);
			this.liveTurns.delete(sessionId);
			this.refreshBusyState();
			if (this.turns.includes(assistantTurn)) this.renderTranscript();
			await this.deps.sessionStore.updateTurns(sessionId, this.uiToStoredTurns(turnSnapshot));
		}
	}

	private handleStop(): void {
		const activeId = this.deps.sessionStore.getActive().id;
		const ctrl = this.inFlights.get(activeId);
		if (!ctrl) return;
		if (this.stoppingSessions.has(activeId)) return;
		this.stoppingSessions.add(activeId);
		this.refreshBusyState();
		this.renderTranscript();
		ctrl.abort();
		this.deps.consent.cancelPendingConsent();
		new Notice("Stopping...");
	}

	private applyErrorToTurn(turn: UiTurn, err: unknown): void {
		turn.thinking = false;
		if (err instanceof AuthError) {
			turn.error = "Authentication failed — check your API key.";
			turn.authError = true;
			return;
		}
		if (err instanceof RateLimitError) {
			turn.error = "Rate-limited by the provider. Try again shortly.";
			return;
		}
		if (err instanceof NetworkError) {
			turn.error = "Network error. Check your connection or endpoint and retry.";
			return;
		}
		if (err instanceof ProviderError) {
			turn.error = `Provider error: ${err.message}`;
			return;
		}
		turn.error = err instanceof Error ? err.message : "Unknown error.";
	}

	private applyPackEvent(packTurn: StoredPackTurnData, event: PackRuntimeEvent): void {
		if (event.kind === "step") {
			packTurn.progressSteps = updatePackProgress(packTurn.progressSteps ?? [], event.step);
			if (event.step.state !== "running") packTurn.retryingStepId = null;
			if (event.step.state === "failed" && event.step.message) {
				packTurn.error = event.step.message;
			}
			if (event.agentWork) {
				packTurn.agentWork = event.agentWork;
			}
			return;
		}
		packTurn.retryingStepId = event.stepId;
	}

	private formatPackRecoveryMessage(packName: string, error: unknown): string {
		if (error instanceof PackConfigError) {
			return `${packName} couldn’t start. Check the pack’s provider and model settings, then retry or switch to Classic mode. (${error.message})`;
		}
		if (error instanceof AuthError) {
			return `${packName} couldn’t authenticate. Check the pack’s API key, then retry or switch to Classic mode.`;
		}
		if (error instanceof RateLimitError) {
			return `${packName} hit the provider rate limit. Wait a moment, then retry or switch to Classic mode.`;
		}
		if (error instanceof NetworkError) {
			return `${packName} couldn’t reach its provider. Check the endpoint or local model server, then retry or switch to Classic mode.`;
		}
		if (error instanceof ProviderError) {
			return `${packName} failed in the provider. Check the pack’s endpoint or model settings, then retry or switch to Classic mode. (${error.message})`;
		}
		const message = error instanceof Error ? error.message : String(error);
		return `${packName} couldn’t finish. Retry, choose another pack, or switch to Classic mode. (${message})`;
	}

	// ─── Transcript ───────────────────────────────────────────────────────────

	private renderTranscript(): void {
		const activeId = this.deps.sessionStore.getActive().id;
		const busy = this.inFlights.has(activeId);

		this.transcriptEl.empty();
		for (let i = 0; i < this.turns.length; i++) {
			const turn = this.turns[i];
			const row = this.transcriptEl.createDiv({ cls: `open-agent-turn open-agent-turn-${turn.role}` });

			if (turn.role === "user") {
				// Header row: "You" label + pencil edit button on right
				const headerRow = row.createDiv({ cls: "open-agent-turn-header-row" });
				headerRow.createEl("div", { cls: "open-agent-turn-role", text: "You" });
				if (!busy && i !== this.editingTurnIndex) {
					const pencilBtn = headerRow.createEl("button", { text: "✏", cls: "open-agent-turn-edit-btn" });
					pencilBtn.setAttribute("aria-label", "Edit message");
					pencilBtn.addEventListener("click", () => {
						this.editingTurnIndex = i;
						this.editingText = turn.content;
						this.renderTranscript();
					});
				}

				if (i === this.editingTurnIndex) {
					// Inline edit mode
					const editArea = row.createEl("textarea", {
						cls: "open-agent-turn-edit-area",
						attr: { rows: "3" },
					});
					editArea.value = this.editingText;
					editArea.addEventListener("input", () => { this.editingText = editArea.value; });
					editArea.addEventListener("keydown", (e) => {
						if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
							e.preventDefault();
							void this.submitEdit(i);
						}
						if (e.key === "Escape") {
							this.editingTurnIndex = null;
							this.renderTranscript();
						}
					});
					const editBtns = row.createDiv({ cls: "open-agent-edit-buttons" });
					editBtns.createEl("button", { text: "Cancel" }).addEventListener("click", () => {
						this.editingTurnIndex = null;
						this.renderTranscript();
					});
					editBtns.createEl("button", { text: "Send", cls: "mod-cta" })
						.addEventListener("click", () => void this.submitEdit(i));
					window.requestAnimationFrame(() => {
						editArea.focus();
						editArea.setSelectionRange(editArea.value.length, editArea.value.length);
					});
				} else {
					if (turn.content.length > 0) {
						const body = row.createEl("div", { cls: "open-agent-turn-body" });
						body.setText(turn.content);
					}
					this.renderTurnImages(row, turn.images);
				}
			} else {
				// Find preceding user turn index (needed for retry button)
				let userTurnIdx = -1;
				for (let j = i - 1; j >= 0; j--) {
					if (this.turns[j].role === "user") { userTurnIdx = j; break; }
				}

				// Header row: "Assistant" label + retry icon on right (when errored)
				const aHeaderRow = row.createDiv({ cls: "open-agent-turn-header-row" });
				aHeaderRow.createEl("div", { cls: "open-agent-turn-role", text: "Assistant" });
				if (!busy && turn.error && userTurnIdx >= 0) {
					const retryBtn = aHeaderRow.createEl("button", { text: "↺", cls: "open-agent-turn-edit-btn" });
					retryBtn.setAttribute("aria-label", "Retry");
					retryBtn.addEventListener("click", () => {
						const retryTurn = this.turns[userTurnIdx];
						const retryText = retryTurn.content;
						const retryImages = [...(retryTurn.images ?? [])];
						this.turns = this.turns.slice(0, userTurnIdx);
						this.inputEl.value = retryText;
						this.pendingImages = retryImages;
						this.renderPendingImages();
						void this.handleSend();
					});
				}

				if (turn.packTurn) {
					this.renderPackTurn(row, turn.packTurn);
				} else if (turn.thinking) {
					const thinkingWrap = row.createDiv({ cls: "open-agent-turn-thinking-wrap" });
					thinkingWrap.createEl("span", {
						cls: "open-agent-turn-thinking-label",
						text: turn.thinkingLabel ?? "Thinking…",
					});
					const dotsEl = thinkingWrap.createDiv({ cls: "open-agent-turn-thinking-dots" });
					dotsEl.createEl("span", { cls: "open-agent-turn-thinking-dot" });
					dotsEl.createEl("span", { cls: "open-agent-turn-thinking-dot" });
					dotsEl.createEl("span", { cls: "open-agent-turn-thinking-dot" });
				}
				if (turn.thinkingContent) {
					const thoughtsWrap = row.createDiv({ cls: "open-agent-turn-thoughts-wrap" });
					const thoughtsToggle = thoughtsWrap.createEl("button", {
						cls: "open-agent-turn-thoughts-toggle",
						attr: { "aria-label": this.thinkingHidden ? "Show thoughts" : "Hide thoughts" },
					});
					thoughtsToggle.createEl("span", {
						cls: "open-agent-turn-thinking-chevron",
						text: this.thinkingHidden ? "▸" : "▾",
					});
					thoughtsToggle.createEl("span", { text: "Thoughts" });
					thoughtsToggle.addEventListener("click", () => {
						this.thinkingHidden = !this.thinkingHidden;
						this.renderTranscript();
					});
					if (!this.thinkingHidden) {
						thoughtsWrap.createEl("div", {
							cls: "open-agent-turn-thoughts-content",
							text: turn.thinkingContent,
						});
					}
				}
				if (!turn.packTurn) {
					for (const seg of turn.segments) {
						if (seg.kind === "text") {
							if (seg.text.length > 0) {
								const body = row.createEl("div", { cls: "open-agent-turn-body" });
								if (busy) {
									// Plain text during streaming to avoid flicker from async MarkdownRenderer
									body.setText(seg.text);
								} else {
									void MarkdownRenderer.render(this.app, seg.text, body, "", this);
								}
							}
						} else {
							const record = turn.toolCallMap[seg.id];
							if (record) this.renderToolCard(row, record);
						}
					}
					this.renderGeneratedImages(row, turn.generatedImages);
				}
			}

			if (turn.degraded) {
				row.createEl("div", {
					cls: "open-agent-turn-meta",
					text: "Non-streaming response — your endpoint does not support streaming.",
				});
			}
			if (turn.capHit) {
				row.createEl("div", { cls: "open-agent-turn-meta", text: "(stopped: hit max-steps cap)" });
			}
			if (turn.interrupted) {
				row.createEl("div", { cls: "open-agent-turn-meta", text: "(interrupted)" });
			}
			if (turn.error) {
				const errEl = row.createEl("div", { cls: "open-agent-turn-error" });
				errEl.setText(turn.error);
				if (turn.authError) {
					errEl.appendText(" ");
					const link = errEl.createEl("a", { text: "Open settings", href: "#" });
					link.addEventListener("click", (e) => { e.preventDefault(); this.deps.openSettings(); });
				}
			}
		}
		this.transcriptEl.scrollTop = this.transcriptEl.scrollHeight;
	}

	private async submitEdit(turnIndex: number): Promise<void> {
		const text = this.editingText.trim();
		const images = [...(this.turns[turnIndex]?.images ?? [])];
		if (!text && images.length === 0) return;
		this.editingTurnIndex = null;
		this.turns = this.turns.slice(0, turnIndex);
		this.inputEl.value = text;
		this.pendingImages = images;
		this.renderPendingImages();
		await this.handleSend();
	}

	// ─── Image attachments ────────────────────────────────────────────

	private async addImageFiles(files: File[]): Promise<void> {
		if (this.deps.sessionStore.getActive().selectedPackId) {
			new Notice("Image attachments are available in Classic mode.");
			return;
		}
		let total = this.pendingImages.reduce((sum, image) => sum + image.size, 0);
		try {
			for (const file of files) {
				if (this.pendingImages.length >= OA_MAX_IMAGES) {
					new Notice(`You can attach up to ${OA_MAX_IMAGES} images per message.`);
					break;
				}
				if (file.size <= 0 || file.size > OA_MAX_IMAGE_BYTES) {
					new Notice(`${file.name}: source image is too large (10 MB each, 64 MB converted total).`);
					continue;
				}
				try {
					const bytes = new Uint8Array(await file.arrayBuffer());
					const mimeType = oaDetectImageMime(bytes);
					if (!mimeType || !OA_IMAGE_MIMES.has(mimeType)) {
						new Notice(`${file.name}: unsupported or invalid image. Use PNG, JPEG, WebP, or GIF.`);
						continue;
					}
					const png = await oaDecodeImageToPng(bytes);
					if (png.length <= 0 || total + png.length > OA_MAX_TOTAL_IMAGE_BYTES) {
						new Notice(`${file.name}: converted PNG exceeds the 64 MB total image limit.`);
						continue;
					}
					this.pendingImages.push({
						id: crypto.randomUUID(),
						name: file.name || "image",
						mimeType: "image/png",
						size: png.byteLength,
						url: oaBytesToDataUrl(png, "image/png"),
					});
					total += png.byteLength;
				} catch (error) {
					new Notice(
						`${file.name}: could not convert image to PNG${error instanceof Error ? ` (${error.message})` : ""}.`,
					);
				}
			}
		} finally {
			this.renderPendingImages();
			this.refreshBusyState();
		}
	}

	private async normalizeConversationImagesToPng(images: PendingImage[]): Promise<PendingImage[]> {
		const result: PendingImage[] = [];
		let total = 0;
		for (const image of images ?? []) {
			if (result.length >= OA_MAX_IMAGES || total >= OA_MAX_TOTAL_IMAGE_BYTES) break;
			if (typeof image?.url !== "string") break;
			try {
				const url = await oaImageUrlToPngDataUrl(image.url);
				const size = Math.ceil((url.length * 3) / 4);
				if (size <= 0 || total + size > OA_MAX_TOTAL_IMAGE_BYTES) continue;
				result.push({ ...image, mimeType: "image/png", size, url });
				total += size;
			} catch {
				// Skip images that cannot be normalized to PNG.
			}
		}
		return result;
	}

	private renderPendingImages(): void {
		if (!this.pendingImagesEl) return;
		this.pendingImagesEl.empty();
		for (const image of this.pendingImages) {
			const chip = this.pendingImagesEl.createDiv({ cls: "open-agent-image-chip" });
			chip.createEl("img", { cls: "open-agent-image-thumb", attr: { src: image.url, alt: image.name } });
			chip.createEl("span", { cls: "open-agent-image-name", text: image.name });
			const removeBtn = chip.createEl("button", { cls: "open-agent-image-remove", text: "×" });
			removeBtn.setAttribute("aria-label", `Remove ${image.name}`);
			removeBtn.addEventListener("click", () => {
				this.pendingImages = this.pendingImages.filter((entry) => entry.id !== image.id);
				this.renderPendingImages();
			});
		}
		if (this.pendingImages.length > 0) {
			this.pendingImagesEl.createDiv({
				cls: "open-agent-image-hint",
				text: "Sent only to vision-capable models.",
			});
		}
	}

	private renderTurnImages(container: HTMLElement, images?: PendingImage[]): void {
		if (!images || images.length === 0) return;
		const wrap = container.createDiv({ cls: "open-agent-turn-images" });
		for (const image of images) {
			wrap.createEl("img", {
				cls: "open-agent-turn-image",
				attr: { src: image.url, alt: image.name, title: image.name, loading: "lazy" },
			});
		}
	}

	private renderGeneratedImages(container: HTMLElement, images?: GeneratedImage[]): void {
		if (!images || images.length === 0) return;
		const wrap = container.createDiv({ cls: "open-agent-generated-images" });
		for (const image of images) {
			const card = wrap.createDiv({ cls: "open-agent-generated-image-card" });
			const file = this.app.vault.getAbstractFileByPath(image.path);
			if (file instanceof TFile) {
				const img = card.createEl("img", {
					cls: "open-agent-generated-image",
					attr: {
						src: this.app.vault.getResourcePath(file),
						alt: image.path,
						title: image.prompt || image.path,
						loading: "lazy",
					},
				});
				img.addEventListener("click", () => {
					void this.app.workspace.getLeaf(false).openFile(file);
				});
			} else {
				card.createEl("div", {
					cls: "open-agent-generated-image-missing",
					text: `Generated image not found: ${image.path}`,
				});
			}
			const openBtn = card.createEl("button", {
				cls: "open-agent-generated-image-open",
				text: image.path,
			});
			openBtn.setAttribute("aria-label", `Open ${image.path}`);
			openBtn.addEventListener("click", () => {
				if (file instanceof TFile) void this.app.workspace.getLeaf(false).openFile(file);
				else new Notice(`Not found: ${image.path}`);
			});
			if (image.model) {
				card.createEl("div", { cls: "open-agent-generated-image-model", text: image.model });
			}
			if (image.referenceImageNames?.length) {
				card.createEl("div", {
					cls: "open-agent-generated-image-model",
					text: `Edited from: ${image.referenceImageNames.join(", ")}`,
				});
			}
		}
	}

	private renderToolCard(parent: HTMLElement, tc: ToolCallRecord): void {
		const cls = ["open-agent-tool-card"];
		if (tc.mutates) cls.push("open-agent-tool-mutates");
		if (tc.status === "ok") cls.push("open-agent-tool-ok");
		if (tc.status === "error") cls.push("open-agent-tool-error");
		if (tc.status === "denied") cls.push("open-agent-tool-denied");
		if (tc.status === "awaiting-consent") cls.push("open-agent-tool-consent");

		const card = parent.createEl("details", { cls: cls.join(" ") });
		if (tc.status === "awaiting-consent" || (tc.name === "image_generate" && tc.status === "error")) {
			card.setAttribute("open", "");
		}
		if (tc.status === "running") card.setAttribute("aria-busy", "true");

		const summary = card.createEl("summary", { cls: "open-agent-tool-summary" });
		summary.createEl("span", { cls: "open-agent-tool-name", text: tc.name });
		summary.createEl("span", { cls: "open-agent-tool-args", text: summarizeArgs(tc.args) });
		summary.createEl("span", {
			cls: "open-agent-tool-status",
			text: statusLabel(tc.status, tc.name),
			attr: { role: "status", "aria-live": "polite" },
		});

		if (tc.status === "awaiting-consent") {
			const diffArea = card.createDiv({ cls: "open-agent-consent-diff-area" });
			if (tc.diffRows === undefined) {
				diffArea.createEl("div", { cls: "open-agent-consent-computing", text: "Computing diff…" });
				this.scheduleDiffComputation(tc);
			} else if (tc.diffRows.length > 0) {
				renderRows(diffArea, tc.diffRows);
			} else {
				diffArea.createEl("div", { cls: "open-agent-consent-computing", text: "(no preview)" });
			}
			const btns = card.createDiv({ cls: "open-agent-consent-inline-buttons" });
			const buttons: HTMLButtonElement[] = [];
			const addButton = (label: string, cls?: string): HTMLButtonElement => {
				const button = btns.createEl("button", { text: label, cls });
				buttons.push(button);
				return button;
			};
			let done = false;
			const choose = (button: HTMLButtonElement, choice: ConsentChoice, label: string): void => {
				button.addEventListener("click", () => {
					if (done || tc.status !== "awaiting-consent") return;
					done = true;
					for (const other of buttons) other.disabled = true;
					if (oaApplyConsentDecision(tc, choice)) button.setText(label);
					this.deps.consent.resolveConsent(choice);
					this.scheduleRender();
				});
			};
			choose(addButton("Reject"), "reject", "Rejected");
			choose(addButton("Approve all this session"), "approve-session", "Approved");
			choose(addButton("Approve", "mod-cta"), "approve", "Approved");
			return;
		}

		const argsEl = card.createEl("pre", { cls: "open-agent-tool-args-full" });
		argsEl.setText(safeStringify(tc.args));

		if (tc.result) {
			const resEl = card.createEl("div", { cls: "open-agent-tool-result" });
			const value = tc.result.ok ? tc.result.value : { error: tc.result.error, details: tc.result.details };
			const stringified = safeStringify(value);
			const preview = stringified.slice(0, 2048);
			const pre = resEl.createEl("pre");
			pre.setText(preview);
			if (stringified.length > preview.length) {
				const more = resEl.createEl("button", {
					cls: "open-agent-tool-more",
					text: `Show ${stringified.length - preview.length} more chars`,
				});
				more.addEventListener("click", () => {
					pre.setText(stringified);
					more.remove();
				});
			}
			const path = extractPath(value);
			if (path) {
				const open = resEl.createEl("button", { cls: "open-agent-tool-open", text: `Open ${path}` });
				open.addEventListener("click", () => {
					const file = this.app.vault.getAbstractFileByPath(path);
					if (file instanceof TFile) {
						const leaf = this.app.workspace.getLeaf(false);
						void leaf.openFile(file);
					} else {
						new Notice(`Not found: ${path}`);
					}
				});
			}
		}

		if (tc.name === "image_generate" && tc.status === "error") {
			const retry = card.createEl("button", {
				cls: "open-agent-tool-retry mod-cta",
				text: "Retry",
				attr: { "aria-label": "Retry image generation with the same payload" },
			});
			retry.addEventListener("click", () => {
				void this.retryImageGenerate(tc);
			});
		}
	}

	// ─── Image retry (I8) ─────────────────────────────────────────

	private async retryImageGenerate(tc: ToolCallRecord): Promise<void> {
		const sessionId = this.deps.sessionStore.getActive().id;
		if (!sessionId) return;
		if (this.inFlights.has(sessionId) || tc.status !== "error" || tc.name !== "image_generate") return;
		const tool = this.deps.tools.get("image_generate");
		if (!tool) {
			new Notice("Image generation tool is unavailable.");
			return;
		}
		const owner = this.turns.find((turn) => turn.role === "assistant" && turn.toolCallMap[tc.id] === tc);
		if (!owner) return;

		const validated = validateArgs(tc.args, tool.schema);
		if (!validated.ok) {
			tc.result = { ok: false, error: `ToolArgError: ${validated.error}` };
			tc.status = "error";
			this.renderTranscript();
			return;
		}

		tc.status = "running";
		tc.result = undefined;
		owner.thinking = true;
		owner.thinkingLabel = "Retrying image_generate…";
		const ctrl = new AbortController();
		this.inFlights.set(sessionId, ctrl);
		this.liveTurns.set(sessionId, this.turns);
		this.refreshBusyState();
		this.renderTranscript();

		const settings = this.deps.getSettings();
		const imageModel =
			this.imageModelInputEl.value.trim() ||
			(this.imageModelCatalog.length === 0 || this.imageModelCatalog.includes(settings.imageModel?.trim())
				? settings.imageModel?.trim()
				: "") ||
			"";

		try {
			const result = await runWithTimeout(
				tool.run(validated.value, {
					signal: ctrl.signal,
					getConversationImages: () => this.getConversationImages(this.turns),
					getImageModel: () => imageModel,
				}),
				tool.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS,
				tool.name,
				ctrl.signal,
			);
			tc.result = result;
			if (result.ok) {
				tc.status = "ok";
				const value = result.value as {
					path?: unknown;
					prompt?: unknown;
					model?: unknown;
					referenceImageNames?: unknown;
				} | null;
				if (value && typeof value === "object" && typeof value.path === "string") {
					const list = owner.generatedImages ?? (owner.generatedImages = []);
					if (!list.some((image) => image.path === value.path)) {
						list.push({
							path: value.path,
							prompt: typeof value.prompt === "string" ? value.prompt : "",
							model: typeof value.model === "string" ? value.model : "",
							referenceImageNames: Array.isArray(value.referenceImageNames)
								? value.referenceImageNames
								: [],
						});
					}
				}
			} else if (result.error.startsWith("ConsentDeniedError")) {
				tc.status = "denied";
			} else {
				tc.status = "error";
			}
		} catch (err) {
			if (err instanceof ToolTimeoutError) {
				tc.result = { ok: false, error: "ToolTimeoutError", details: err.message };
			} else if (err instanceof Error) {
				tc.result = { ok: false, error: err.name || "ToolError", details: err.message };
			} else {
				tc.result = { ok: false, error: "ToolError", details: String(err) };
			}
			tc.status = "error";
		} finally {
			owner.thinking = false;
			owner.thinkingLabel = undefined;
			this.inFlights.delete(sessionId);
			this.liveTurns.delete(sessionId);
			this.refreshBusyState();
			this.renderTranscript();
			await this.deps.sessionStore.updateTurns(sessionId, this.uiToStoredTurns(this.turns));
		}
	}

	private renderPackTurn(parent: HTMLElement, packTurn: StoredPackTurnData): void {
			if (this.shouldUsePackTranscriptRedesign(packTurn)) {
				this.renderRedesignedPackTurn(parent, packTurn);
				return;
			}

			if (packTurn.verifiedSummary && packTurn.verifiedSummary.trim().length > 0) {
				parent.createEl("div", { cls: "open-agent-pack-section-title", text: "Verified summary" });
				const summaryBody = parent.createDiv({ cls: "open-agent-turn-body" });
				void MarkdownRenderer.render(this.app, packTurn.verifiedSummary, summaryBody, "", this);
			} else if (packTurn.claims && packTurn.claims.length > 0 && packTurn.claims.every((claim) => claim.status !== "verified")) {
				parent.createEl("div", { cls: "open-agent-pack-section-title", text: "Verification failed" });
				parent.createEl("div", {
					cls: "open-agent-pack-step-message",
					text: "No claims could be verified against your notes.",
				});
			}

			const verifiedClaims = (packTurn.claims ?? []).filter((claim) => claim.status === "verified");
			for (const claim of verifiedClaims) {
				this.renderPackClaim(parent, claim);
			}

			const flaggedClaims = (packTurn.claims ?? []).filter((claim) => claim.status !== "verified");
			if (flaggedClaims.length > 0) {
				parent.createEl("div", { cls: "open-agent-pack-section-title", text: "Flagged claims" });
			}
			for (const claim of flaggedClaims) {
				this.renderPackClaim(parent, claim);
			}

			if (packTurn.modelsUsed) {
				parent.createEl("div", {
					cls: "open-agent-pack-model-footer",
					text:
						`Models used: Retriever — ${packTurn.modelsUsed.retriever}; ` +
						`Synthesizer — ${packTurn.modelsUsed.synthesizer}; ` +
						`Verifier — ${packTurn.modelsUsed.verifier}`,
				});
			}
		}

		private shouldUsePackTranscriptRedesign(packTurn: StoredPackTurnData): boolean {
			if ((packTurn.progressSteps?.length ?? 0) === 0) return false;
			return Boolean(
				packTurn.agentWork ||
				packTurn.researchMarkdown !== undefined ||
				packTurn.citations !== undefined ||
				"retryingStepId" in packTurn,
			);
		}

		private renderRedesignedPackTurn(parent: HTMLElement, packTurn: StoredPackTurnData): void {
			const agentWork = packTurn.agentWork;
			const runState = agentWork?.run.state ?? "running";
			const researchMarkdown = packTurn.researchMarkdown?.trim() ?? "";
			const isStopping = runState === "running" && this.stoppingSessions.has(this.deps.sessionStore.getActive().id);
			const isStopped = runState === "stopped";

			if (runState !== "running") {
				const resultSection = parent.createDiv({ cls: "open-agent-pack-result" });
				resultSection.createEl("div", {
					cls: "open-agent-pack-section-title",
					text: isStopped ? "Research stopped" : researchMarkdown ? "Research result" : "Research result unavailable",
				});
				resultSection.createEl("div", {
					cls: "open-agent-pack-result-meta",
					text: formatDuration(agentWork.run.elapsedMs),
				});
				const resultBody = resultSection.createDiv({
					cls: "open-agent-turn-body open-agent-pack-result-body",
				});
				if (isStopped) {
					resultBody.setText(
						"This run was stopped before it finished. Any completed step output remains available below.",
					);
				} else if (researchMarkdown) {
					this.renderResearchMarkdown(resultBody, researchMarkdown, packTurn.citations ?? []);
				} else {
					resultBody.setText(
						"This run did not produce a citation-ready research answer. Review the completed steps and claim details below, then rerun research if needed.",
					);
				}
			}

			parent.createEl("div", {
				cls: `open-agent-pack-progress-title${isStopping ? " is-stopping" : ""}`,
				text: isStopping
					? "Stopping research..."
					: isStopped
						? "Progress before stop"
						: runState === "running"
							? "Agent steps"
							: "How this answer was built",
			});
			const progress = parent.createDiv({ cls: "open-agent-pack-progress" });
			const expandedStepSetters: Array<(open: boolean) => void> = [];
			let expandedStepId = this.getInitialExpandedPackStep(packTurn, agentWork);

			for (const step of packTurn.progressSteps ?? []) {
				const stepId = step.id;
				const details = this.getPackStepDetails(stepId, agentWork);
				const readyDetails = details?.status === "ready" ? details : null;
				const expandable = Boolean(details || step.message);
				const stepDuration = formatDuration(agentWork?.run.stepElapsedMs[toPackRunStepId(step.id)]);
				const showStepDuration = stepDuration !== "Timing unavailable";
				const isStoppingStep = isStopping && step.state === "running";
				const isStoppedStep = isStopped && step.message === "Stopped by user.";
				const stepEl = progress.createDiv({
					cls: `open-agent-pack-step open-agent-pack-step-${step.state}`,
				});
				stepEl.classList.toggle("is-expandable", expandable);
				stepEl.classList.toggle("is-static", !expandable);
				stepEl.classList.toggle("is-expanded", expandable && expandedStepId === stepId);
				stepEl.classList.toggle("is-stopping", isStoppingStep);
				stepEl.classList.toggle("is-stopped", isStoppedStep);
				if (expandable) {
					stepEl.setAttribute("role", "button");
					stepEl.setAttribute("tabindex", "0");
					stepEl.setAttribute("aria-expanded", String(expandedStepId === stepId));
				}

				const header = stepEl.createDiv({ cls: "open-agent-pack-step-header" });
				const heading = header.createDiv({ cls: "open-agent-pack-step-heading" });
				heading.createEl("div", {
					cls: "open-agent-pack-step-label",
					text: packStepTitle(step),
				});
				const meta = header.createDiv({ cls: "open-agent-pack-step-meta" });
				meta.createEl("span", {
					cls: `open-agent-pack-step-state open-agent-pack-step-state-${isStoppingStep ? "stopping" : isStoppedStep ? "stopped" : step.state}`,
					text: isStoppingStep ? "Stopping" : isStoppedStep ? "Stopped" : packStepStateLabel(step.state),
				});
				if (showStepDuration) {
					meta.createEl("span", {
						cls: "open-agent-pack-step-duration",
						text: stepDuration,
					});
				}
				let disclosure: HTMLElement | null = null;
				if (expandable) {
					disclosure = meta.createEl("span", {
						cls: "open-agent-pack-step-disclosure",
						text: expandedStepId === stepId ? "▾" : "▸",
					});
				}

				this.renderPackStepSummary(stepEl, stepId, readyDetails);
				if (packTurn.retryingStepId === step.id) {
					stepEl.createEl("div", {
						cls: "open-agent-pack-retry",
						text: "Retrying structured output (1/1)…",
					});
				}
				if (step.state === "failed" && step.message) {
					stepEl.createEl("div", { cls: "open-agent-pack-step-message", text: step.message });
				}

				const detailEl = stepEl.createDiv({ cls: "open-agent-pack-step-details" });
				if (readyDetails) {
					this.renderPackStepDetails(detailEl, stepId, readyDetails);
				} else {
					detailEl.createEl("div", {
						cls: "open-agent-pack-step-empty",
						text: details?.status === "pending" ? "Waiting for step to finish." : "No details captured.",
					});
				}

				const setExpanded = (open: boolean): void => {
					detailEl.classList.toggle("is-hidden", !open);
					if (expandable) {
						stepEl.setAttribute("aria-expanded", String(open));
						stepEl.classList.toggle("is-expanded", open);
						disclosure?.setText(open ? "▾" : "▸");
					}
				};
				expandedStepSetters.push(setExpanded);
				setExpanded(expandedStepId === stepId);

				if (expandable) {
					stepEl.addEventListener("click", () => {
						expandedStepId = expandedStepId === stepId ? null : stepId;
						this.packExpandedStepId.set(packTurn, expandedStepId);
						for (let index = 0; index < expandedStepSetters.length; index += 1) {
							const targetStep = packTurn.progressSteps?.[index];
							expandedStepSetters[index]?.(targetStep?.id === expandedStepId);
						}
					});
					stepEl.addEventListener("keydown", (event) => {
						if (event.key !== "Enter" && event.key !== " ") return;
						event.preventDefault();
						stepEl.click();
					});
				}
			}

			for (const claim of packTurn.claims ?? []) {
				this.renderPackClaim(parent, claim);
			}

			if (packTurn.modelsUsed) {
				parent.createEl("div", {
					cls: "open-agent-pack-model-footer",
					text:
						`Models used: Retriever — ${packTurn.modelsUsed.retriever}; ` +
						`Synthesizer — ${packTurn.modelsUsed.synthesizer}; ` +
						`Verifier — ${packTurn.modelsUsed.verifier}`,
				});
			}
		}

		private getInitialExpandedPackStep(
			packTurn: StoredPackTurnData,
			agentWork: PackRunTransparency | undefined,
		): string | null {
			const existing = this.packExpandedStepId.get(packTurn);
			if (existing !== undefined) return existing;
			const initial = agentWork?.run.state === "failed" ? agentWork.run.failedStepId ?? null : null;
			this.packExpandedStepId.set(packTurn, initial);
			return initial;
		}

		private renderPackStepSummary(
			parent: HTMLElement,
			stepId: string,
			details:
				| PackRunTransparency["retriever"]
				| PackRunTransparency["synthesizer"]
				| PackRunTransparency["verifier"]
				| null,
		): void {
			if (!details) return;
			const summary = parent.createDiv({ cls: "open-agent-pack-step-summary" });
			if (stepId === "retriever" && "notesFoundCount" in details) {
				summary.createEl("span", {
					cls: "open-agent-work-summary-text",
					text: `${details.notesFoundCount ?? 0} notes`,
				});
				for (const path of details.topNotePaths ?? []) {
					this.renderNotePathChip(summary, path);
				}
				const extraCount = Math.max(0, (details.notesFoundCount ?? 0) - (details.topNotePaths?.length ?? 0));
				if (extraCount > 0) {
					summary.createEl("span", {
						cls: "open-agent-work-summary-text open-agent-work-muted",
						text: `+${extraCount} more`,
					});
				}
				return;
			}
			if (stepId === "synthesizer" && "claimCount" in details) {
				summary.createEl("span", {
					cls: "open-agent-work-summary-text",
					text: `${details.claimCount ?? 0} draft claims`,
				});
				summary.createEl("span", {
					cls: "open-agent-work-summary-text",
					text: truncateAgentWorkPreview(details.summary ?? ""),
				});
				return;
			}
			if (stepId === "verifier" && "counts" in details) {
				const counts = details.counts ?? { verified: 0, unsupported: 0, quoteMissing: 0 };
				summary.createEl("span", { cls: "open-agent-work-chip open-agent-work-chip-verified", text: `Verified ${counts.verified}` });
				summary.createEl("span", { cls: "open-agent-work-chip open-agent-work-chip-unsupported", text: `Unsupported ${counts.unsupported}` });
				summary.createEl("span", {
					cls: "open-agent-work-chip open-agent-work-chip-quote-missing",
					text: `Quote missing ${counts.quoteMissing}`,
				});
			}
		}

		private renderPackStepDetails(
			parent: HTMLElement,
			stepId: string,
			details:
				| PackRunTransparency["retriever"]
				| PackRunTransparency["synthesizer"]
				| PackRunTransparency["verifier"],
		): void {
			if (stepId === "retriever" && "notesFoundCount" in details) {
				parent.createEl("div", {
					cls: "open-agent-work-brief",
					text: details.brief ?? "No details captured.",
				});
				return;
			}
			if (stepId === "synthesizer" && "claimCount" in details) {
				parent.createEl("div", {
					cls: "open-agent-work-brief",
					text: truncateAgentWorkPreview(details.summary ?? ""),
				});
				parent.createEl("div", { cls: "open-agent-work-raw-json-label", text: "Raw JSON" });
				const rawJson = parent.createEl("pre", { cls: "open-agent-work-raw-json" });
				rawJson.setText(safeStringify(details.rawJson ?? {}));
				return;
			}
			if (stepId === "verifier" && "reasons" in details) {
				for (const reason of details.reasons ?? []) {
					const row = parent.createDiv({ cls: "open-agent-work-verifier-row" });
					row.createEl("span", {
						cls: verifierReasonStatusClass(reason.status),
						text: claimStatusLabel(reason.status),
					});
					row.createEl("span", {
						cls: "open-agent-work-verifier-claim",
						text: truncateClaimPreview(reason.claimText),
					});
					row.createEl("span", {
						cls: "open-agent-work-verifier-source",
						text: sourceNoteLabel(reason.sourceNote),
					});
					row.createEl("span", {
						cls: "open-agent-work-verifier-explanation",
						text: reason.explanation,
					});
				}
			}
		}

		private renderNotePathChip(parent: HTMLElement, path: string): void {
			const chip = parent.createEl("span", {
				cls: "open-agent-work-note-path",
				text: path,
			});
			chip.addEventListener("click", (event) => {
				(event as MouseEvent & { stopPropagation?: () => void }).stopPropagation?.();
				this.openStoredNote(path);
			});
		}

		private renderResearchMarkdown(parent: HTMLElement, markdown: string, citations: NonNullable<StoredPackTurnData["citations"]>): void {
			for (const paragraph of markdown.split(/\n{2,}/).map((value) => value.trim()).filter(Boolean)) {
				const paragraphEl = parent.createEl("p");
				this.renderResearchParagraph(paragraphEl, paragraph, citations);
			}
		}

		private renderResearchParagraph(
			parent: HTMLElement,
			paragraph: string,
			citations: NonNullable<StoredPackTurnData["citations"]>,
		): void {
			const citationPattern = /\[(\d+)\]\(openagent:\/\/citation\/\1\)/g;
			let cursor = 0;
			for (const match of paragraph.matchAll(citationPattern)) {
				const index = match.index ?? 0;
				if (index > cursor) {
					parent.appendText(paragraph.slice(cursor, index));
				}
				const citationIndex = Number(match[1]) - 1;
				const citation = citations[citationIndex];
				if (!citation) {
					parent.appendText(match[0]);
				} else {
					const link = parent.createEl("button", {
						cls: "open-agent-citation-link",
						text: `[${citationIndex + 1}]`,
					});
					link.setAttribute("type", "button");
					link.addEventListener("click", (event) => {
						event.preventDefault();
						void this.openCitationTarget(citation);
					});
				}
				cursor = index + match[0].length;
			}
			if (cursor < paragraph.length) {
				parent.appendText(paragraph.slice(cursor));
			}
		}

		private async openCitationTarget(citation: ExactPhraseAnchor): Promise<void> {
			const file = this.app.vault.getAbstractFileByPath(citation.notePath);
			if (!(file instanceof TFile)) {
				new Notice(`Not found: ${citation.notePath}`);
				return;
			}
			const leaf = this.app.workspace.getLeaf(false);
			const noteBody = await this.app.vault.cachedRead(file);
			const resolution = resolveCitationTarget(citation, noteBody);
			if (resolution.kind === "fallback") {
				await leaf.openFile(file);
				new Notice(resolution.message);
				return;
			}
			await leaf.openFile(file, {
				active: true,
				eState: {
					selection: {
						from: offsetToEditorPosition(noteBody, resolution.startOffset),
						to: offsetToEditorPosition(noteBody, resolution.endOffset),
					},
				},
			});
		}

		private getPackStepDetails(
			stepId: string,
			agentWork: PackRunTransparency | undefined,
		):
			| PackRunTransparency["retriever"]
			| PackRunTransparency["synthesizer"]
			| PackRunTransparency["verifier"]
			| null {
			if (!agentWork) return null;
			switch (stepId) {
				case "retriever":
					return agentWork.retriever;
				case "synthesizer":
					return agentWork.synthesizer;
				case "verifier":
					return agentWork.verifier;
				default:
					return null;
			}
		}

		private openStoredNote(path: string): void {
			const file = this.app.vault.getAbstractFileByPath(path);
			if (file instanceof TFile) {
				void this.app.workspace.getLeaf(false).openFile(file);
			} else {
				new Notice(`Not found: ${path}`);
			}
		}

		private renderPackClaim(parent: HTMLElement, claim: StoredPackClaim): void {
			const card = parent.createDiv({ cls: `open-agent-claim open-agent-claim-${claim.status}` });
			const header = card.createDiv({ cls: "open-agent-claim-header" });
			header.createEl("span", { cls: "open-agent-claim-badge", text: claimStatusLabel(claim.status) });
			header.createEl("div", { cls: "open-agent-claim-text", text: claim.text });

			const meta = card.createDiv({ cls: "open-agent-claim-meta" });
			const sourceBtn = meta.createEl("button", { text: "Open source note", cls: "open-agent-claim-open" });
			sourceBtn.addEventListener("click", () => {
				if (claim.exactPhraseAnchor) {
					void this.openCitationTarget(claim.exactPhraseAnchor);
				} else {
					this.openStoredNote(claim.sourceNote);
				}
			});
			meta.createEl("span", { cls: "open-agent-claim-source", text: sourceNoteLabel(claim.sourceNote) });

			const details = card.createDiv({ cls: "open-agent-claim-details" });
			const shouldExpand = claim.status !== "verified";
			const toggle = meta.createEl("button", {
				text: shouldExpand ? "Hide evidence" : "Show evidence",
				cls: "open-agent-claim-toggle",
			});
			details.classList.toggle("is-hidden", !shouldExpand);
			toggle.addEventListener("click", () => {
				const open = details.classList.contains("is-hidden");
				details.classList.toggle("is-hidden", !open);
				toggle.textContent = open ? "Hide evidence" : "Show evidence";
			});

			details.createEl("div", {
				cls: "open-agent-claim-quote",
				text: claim.quotePresent ? claim.sourceQuote : "Quoted text not found in the live note.",
			});
			if (claim.supportExplanation.trim().length > 0) {
				details.createEl("div", { cls: "open-agent-claim-explanation", text: claim.supportExplanation });
			}
		}

		private scheduleDiffComputation(tc: ToolCallRecord): void {
		if (this.diffComputedIds.has(tc.id)) return;
		this.diffComputedIds.add(tc.id);
		void this.computeAndStoreDiff(tc);
	}

	private async computeAndStoreDiff(tc: ToolCallRecord): Promise<void> {
		tc.diffRows = await this.buildDiffRows(tc);
		this.renderTranscript();
	}

	private async buildDiffRows(tc: ToolCallRecord): Promise<DiffRow[]> {
		try {
			const args = tc.args as Record<string, unknown>;
			const path = typeof args.path === "string" ? args.path : null;
			const file = path ? this.app.vault.getAbstractFileByPath(path) : null;
			const existing = file instanceof TFile ? await this.app.vault.read(file) : "";

			if (tc.name === "vault_edit") {
				const oldString = typeof args.oldString === "string" ? args.oldString : "";
				const newString = typeof args.newString === "string" ? args.newString : "";
				return diffLines(existing, existing.split(oldString).join(newString));
			}
			if (tc.name === "vault_append") {
				const content = typeof args.content === "string" ? args.content : "";
				const ensureNewline = args.ensureNewline !== false;
				const sep = ensureNewline && existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
				return diffLines(existing, existing + sep + content);
			}
			if (tc.name === "vault_write") {
				const body = typeof args.body === "string" ? args.body : "";
				const fm = args.frontmatter && typeof args.frontmatter === "object" ? args.frontmatter as Record<string, unknown> : undefined;
				const split = splitFrontmatter(existing);
				const afterFm = fm ? mergeFrontmatter(split.frontmatter ?? {}, fm) : split.frontmatter;
				return diffLines(existing, stitchFrontmatter(afterFm, body));
			}
		} catch {
			// fall through
		}
		return [];
	}
}

function summarizeArgs(args: unknown): string {
	if (!args || typeof args !== "object") return "";
	const entries = Object.entries(args as Record<string, unknown>).slice(0, 3);
	const parts = entries.map(([k, v]) => `${k}=${shortValue(v)}`);
	return `(${parts.join(", ")}${Object.keys(args).length > 3 ? ", …" : ""})`;
}

function shortValue(v: unknown): string {
	if (typeof v === "string") return v.length > 40 ? `"${v.slice(0, 37)}…"` : `"${v}"`;
	if (typeof v === "number" || typeof v === "boolean") return String(v);
	if (v === null) return "null";
	if (Array.isArray(v)) return `[${v.length}]`;
	return "{…}";
}

function oaApplyConsentDecision(record: ToolCallRecord, choice: ConsentChoice): boolean {
	if (record.status !== "awaiting-consent") return false;
	if (choice === "reject") {
		record.status = "denied";
	} else {
		record.status = "running";
		record.approvedPending = true;
	}
	return true;
}

function statusLabel(s: ToolCallRecord["status"], toolName?: string): string {
	switch (s) {
		case "running":
			return toolName === "image_generate" ? "generating image…" : "running…";
		case "awaiting-consent":
			return "awaiting consent…";
		case "ok":
			return "ok";
		case "error":
			return "error";
		case "denied":
			return "denied";
	}
}

function safeStringify(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

function extractPath(value: unknown): string | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const p = (value as Record<string, unknown>).path;
	return typeof p === "string" ? p : null;
}

function updatePackProgress(
	steps: StoredPackProgressStep[],
	nextStep: StoredPackProgressStep,
): StoredPackProgressStep[] {
	const updated = steps.map((step) => (step.id === nextStep.id ? nextStep : step));
	if (updated.some((step) => step.id === nextStep.id)) return updated;
	return [...updated, nextStep];
}

function markPackFailed(steps: StoredPackProgressStep[]): void {
	const running = steps.find((step) => step.state === "running");
	if (running) running.state = "failed";
}

function markPackStopped(steps: StoredPackProgressStep[]): void {
	const running = steps.find((step) => step.state === "running");
	if (!running) return;
	running.state = "failed";
	running.message = "Stopped by user.";
}

function claimStatusLabel(status: StoredPackClaim["status"]): string {
	switch (status) {
		case "verified":
			return "Verified";
		case "unsupported":
			return "Unsupported";
		case "quote-missing":
			return "Quote missing";
	}
}

function sourceNoteLabel(path: string): string {
	const parts = path.split("/");
	return parts[parts.length - 1] || path;
}

function truncateAgentWorkPreview(text: string): string {
	const normalized = text.replace(/\r\n/g, "\n").trim();
	if (!normalized) return "";
	const twoLines = normalized.split("\n").slice(0, 2).join(" ");
	if (twoLines.length <= 140 && twoLines === normalized.replace(/\n/g, " ")) return twoLines;
	const truncated = twoLines.slice(0, 140).trimEnd();
	return `${truncated.replace(/[.,;:!?-]$/, "")}…`;
}

function truncateClaimPreview(text: string): string {
	const normalized = text.trim();
	if (normalized.length <= 96) return normalized;
	return `${normalized.slice(0, 96).trimEnd()}…`;
}

function packStepTitle(step: StoredPackProgressStep): string {
	switch (step.id) {
		case "retriever":
			return "Retriever";
		case "synthesizer":
			return "Synthesizer";
		case "verifier":
			return "Verifier";
		default:
			return step.label;
	}
}

function packStepStateLabel(state: StoredPackProgressStep["state"]): string {
	switch (state) {
		case "pending":
			return "Pending";
		case "running":
			return "Running";
		case "complete":
			return "Complete";
		case "failed":
			return "Failed";
	}
}

function toPackRunStepId(stepId: string): "retriever" | "synthesizer" | "verifier" {
	switch (stepId) {
		case "retriever":
		case "synthesizer":
		case "verifier":
			return stepId;
		default:
			return "verifier";
	}
}

function verifierReasonStatusClass(status: StoredPackClaim["status"]): string {
	switch (status) {
		case "verified":
			return "open-agent-work-chip open-agent-work-chip-verified";
		case "unsupported":
			return "open-agent-work-chip open-agent-work-chip-unsupported";
		case "quote-missing":
			return "open-agent-work-chip open-agent-work-chip-quote-missing";
	}
}

function offsetToEditorPosition(text: string, offset: number): { line: number; ch: number } {
	const boundedOffset = Math.max(0, Math.min(offset, text.length));
	const preceding = text.slice(0, boundedOffset).split("\n");
	const line = preceding.length - 1;
	const ch = preceding[preceding.length - 1]?.length ?? 0;
	return { line, ch };
}

function formatDuration(ms: number | undefined): string {
	if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) {
		return "Timing unavailable";
	}
	if (ms < 10_000) {
		return `${(ms / 1000).toFixed(1)}s`;
	}
	const roundedSeconds = Math.round(ms / 1000);
	if (roundedSeconds < 60) {
		return `${roundedSeconds}s`;
	}
	const minutes = Math.floor(roundedSeconds / 60);
	const seconds = roundedSeconds % 60;
	return `${minutes}m ${seconds}s`;
}
