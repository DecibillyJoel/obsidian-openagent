import { App, PluginSettingTab, Setting } from "obsidian";
import type OpenAgentPlugin from "./main";
import { DEFAULT_CONSENT, type ConsentSettings } from "./consent/manager";
import { oaBuildModelOptionGroups, oaCatalogWithCurrent, type ModelCategory, type ModelCategoryKind } from "./models/categories";
import { oaPaintModelSelect, type ModelSelectPseudoOption } from "./models/selectOptions";
import { oaNewCategoriesSectionState, renderModelCategoriesSection } from "./models/categoriesSection";
import { loadPacks } from "./packs/loader";
import type { AgentPack } from "./packs/types";
import { oaFetchModelIds, oaModelEligibleOrUnknown } from "./provider";
import type { OpenAICompatibleConfig } from "./provider-config";
import type { ConsentMode } from "./types";

export type ProviderId = "openai-compatible";

export interface PluginSettings {
	provider: ProviderId;
	baseUrl: string;
	apiKey: string;
	model: string;
	imageModel: string;
	systemPrompt: string;
	consent: ConsentSettings;
	packProviderOverrides: Record<string, Record<string, Partial<OpenAICompatibleConfig>>>;
	modelCategories: ModelCategory[];
}

export const DEFAULT_SETTINGS: PluginSettings = {
	provider: "openai-compatible",
	baseUrl: "https://api.openai.com/v1",
	apiKey: "",
	model: "gpt-4o-mini",
	imageModel: "",
	systemPrompt: "",
	consent: { ...DEFAULT_CONSENT },
	packProviderOverrides: {},
	modelCategories: [],
};

/** Reads a stored field as text. Returns an empty string when the stored value is not a string. */
function storedString(value: unknown): string {
	return typeof value === "string" ? value : "";
}

export function isConfigured(s: PluginSettings): boolean {
	const baseUrl = storedString(s.baseUrl).trim();
	const apiKey = storedString(s.apiKey).trim();
	const model = storedString(s.model).trim();
	return baseUrl.length > 0 && apiKey.length > 0 && model.length > 0;
}

export class OpenAgentSettingsTab extends PluginSettingTab {
	private readonly plugin: OpenAgentPlugin;
	private modelSelectPainters: Array<() => void> = [];
	/** Outlives every paint of the tab, so an open category stays open. */
	private readonly categoriesState = oaNewCategoriesSectionState();

	constructor(app: App, plugin: OpenAgentPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		this.modelSelectPainters = [];
		const { containerEl } = this;
		containerEl.empty();

		const keyNotice = containerEl.createEl("div", { cls: "open-agent-notice" });
		keyNotice.createEl("strong", { text: "Key storage: " });
		keyNotice.appendText(
			`Your API key is stored in this plugin's data file (${this.app.vault.configDir}/plugins/open-agent/data.json). ` +
				"If you sync that folder via Obsidian Sync or another sync tool, the key travels with it.",
		);

		const vaultNotice = containerEl.createEl("div", { cls: "open-agent-notice" });
		vaultNotice.createEl("strong", { text: "Data sent to model endpoint: " });
		vaultNotice.appendText(
			"with tools enabled, the agent may transmit note bodies, paths, frontmatter, tags, prompts, and selected image data to the model endpoint you've configured. Choose endpoints you trust.",
		);

		new Setting(containerEl)
			.setName("Provider")
			.setDesc("any compatible API endpoint (more providers coming soon).")
			.addDropdown((drop) => {
				drop.addOption("openai-compatible", "OpenAI compatible");
				drop.setValue(this.plugin.settings.provider);
				drop.onChange(async (v) => {
					this.plugin.settings.provider = v as ProviderId;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName("Base URL")
			.setDesc("e.g. https://api.openai.com/v1, https://openrouter.ai/api/v1, http://192.168.x.x:11434/v1")
			.addText((txt) =>
				txt
					.setPlaceholder("https://api.openai.com/v1")
					.setValue(this.plugin.settings.baseUrl)
					.onChange(async (v) => {
						this.plugin.settings.baseUrl = v.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("API key")
			.setDesc("bearer token stored in plugin data, never in local storage or the vault.")
			.addText((txt) => {
				txt.setPlaceholder("")
					.setValue(this.plugin.settings.apiKey)
					.onChange(async (v) => {
						this.plugin.settings.apiKey = v;
						await this.plugin.saveSettings();
					});
				txt.inputEl.type = "password";
				txt.inputEl.autocomplete = "off";
			});

		const modelContainer = containerEl.createDiv();
		this.renderModelSetting(
			modelContainer,
			"Model",
			"Model name as accepted by your endpoint.",
			() => this.plugin.settings.model,
			async (v) => {
				this.plugin.settings.model = v;
				await this.plugin.saveSettings();
			},
			() => this.plugin.settings.baseUrl,
			() => this.plugin.settings.apiKey,
			"text",
		);

		const imageModelContainer = containerEl.createDiv();
		this.renderModelSetting(
			imageModelContainer,
			"Image generation model",
			"Default image model for chats. Shows image-generation-capable models only and excludes batch variants.",
			() => this.plugin.settings.imageModel ?? "",
			async (v) => {
				this.plugin.settings.imageModel = v;
				await this.plugin.saveSettings();
			},
			() => this.plugin.settings.baseUrl,
			() => this.plugin.settings.apiKey,
			"image",
		);

		new Setting(containerEl)
			.setName("System prompt")
			.setDesc("Optional. Prepended to every conversation.")
			.addTextArea((txt) =>
				txt
					.setPlaceholder("You are a helpful assistant…")
					.setValue(this.plugin.settings.systemPrompt)
					.onChange(async (v) => {
						this.plugin.settings.systemPrompt = v;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl).setName("Model categories").setHeading();
		renderModelCategoriesSection(containerEl, {
			state: this.categoriesState,
			getCategories: () => this.plugin.settings.modelCategories,
			setCategories: async (next) => {
				this.plugin.settings.modelCategories = next;
				await this.plugin.saveSettings();
			},
			getEndpoint: () => ({
				baseUrl: this.plugin.settings.baseUrl,
				apiKey: this.plugin.settings.apiKey,
			}),
			onChanged: () => {
				for (const paint of this.modelSelectPainters) paint();
			},
		});

		new Setting(containerEl).setName("Tool consent").setHeading();

		this.consentDropdown(containerEl, "Read tools", "vault_read");
		this.consentDropdown(containerEl, "Write tools", "vault_write");

		new Setting(containerEl).setName("Pack models").setHeading();

		const packSectionEl = containerEl.createDiv();
		const loadingEl = packSectionEl.createEl("p", { text: "Loading packs…", cls: "open-agent-notice" });

		void loadPacks(this.app, this.plugin.manifest.dir).then((packs) => {
			loadingEl.remove();
			this.renderPackProviderOverrides(packSectionEl, packs);
		});
	}

	private renderPackProviderOverrides(containerEl: HTMLElement, packs: AgentPack[]): void {
		if (packs.length === 0) {
			containerEl.createEl("p", { text: "No packs installed.", cls: "open-agent-notice" });
			return;
		}
		for (const pack of packs) {
			containerEl.createEl("strong", { text: pack.name });
			for (const providerName of Object.keys(pack.providers)) {
				const jsonConfig = pack.providers[providerName];
				const label = providerName.charAt(0).toUpperCase() + providerName.slice(1);

				new Setting(containerEl)
					.setName(`${label} — Base URL`)
					.setDesc(`Default: ${jsonConfig?.baseUrl ?? ""}`)
					.addText((txt) =>
						txt
							.setPlaceholder(jsonConfig?.baseUrl ?? "")
							.setValue(this.plugin.settings.packProviderOverrides[pack.id]?.[providerName]?.baseUrl ?? "")
							.onChange(async (v) => {
								this.savePackProviderField(pack.id, providerName, "baseUrl", v.trim());
								await this.plugin.saveSettings();
							}),
					);

				new Setting(containerEl)
					.setName(`${label} — API key`)
					.setDesc("Leave blank to use the value from the pack config file.")
					.addText((txt) => {
						txt
							.setPlaceholder("")
							.setValue(this.plugin.settings.packProviderOverrides[pack.id]?.[providerName]?.apiKey ?? "")
							.onChange(async (v) => {
								this.savePackProviderField(pack.id, providerName, "apiKey", v);
								await this.plugin.saveSettings();
							});
						txt.inputEl.type = "password";
						txt.inputEl.autocomplete = "off";
					});

				const packModelContainer = containerEl.createDiv();
				this.renderModelSetting(
					packModelContainer,
					`${label} — Model`,
					`Default: ${jsonConfig?.model ?? ""}`,
					() => this.plugin.settings.packProviderOverrides[pack.id]?.[providerName]?.model ?? "",
					async (v) => {
						this.savePackProviderField(pack.id, providerName, "model", v);
						await this.plugin.saveSettings();
					},
					() =>
						this.plugin.settings.packProviderOverrides[pack.id]?.[providerName]?.baseUrl ??
						jsonConfig?.baseUrl ??
						"",
					() =>
						this.plugin.settings.packProviderOverrides[pack.id]?.[providerName]?.apiKey ??
						jsonConfig?.apiKey ??
						"",
				);
			}
		}
	}

	private savePackProviderField(
		packId: string,
		providerName: string,
		field: keyof OpenAICompatibleConfig,
		value: string,
	): void {
		if (!this.plugin.settings.packProviderOverrides[packId]) {
			this.plugin.settings.packProviderOverrides[packId] = {};
		}
		if (!this.plugin.settings.packProviderOverrides[packId][providerName]) {
			this.plugin.settings.packProviderOverrides[packId][providerName] = {};
		}
		if (value) {
			this.plugin.settings.packProviderOverrides[packId][providerName][field] = value;
		} else {
			delete this.plugin.settings.packProviderOverrides[packId][providerName][field];
		}
	}

	private renderModelSetting(
		container: HTMLElement,
		name: string,
		desc: string,
		getValue: () => string,
		onSave: (v: string) => Promise<void>,
		getBaseUrl: () => string,
		getApiKey: () => string,
		kind: ModelCategoryKind = "text",
	): void {
		container.empty();
		const saved = getValue();

		if (!getBaseUrl().trim()) {
			new Setting(container)
				.setName(name)
				.setDesc(desc)
				.addText((txt) =>
					txt
						.setPlaceholder("")
						.setValue(saved)
						.onChange(async (v) => {
							await onSave(v.trim());
						}),
				);
			return;
		}

		let selectEl: HTMLSelectElement | null = null;
		let catalog: string[] = [];

		const paint = (): void => {
			if (!selectEl) return;
			const current = getValue();
			const allModels = oaCatalogWithCurrent(catalog, current, (id) => oaModelEligibleOrUnknown(id, kind));
			// A model the options do not hold is never selected for the user. The
			// empty option stands in, so a fetch cannot save a substitute.
			const kept = allModels.includes(current) ? current : "";
			// The pseudo option carries the stored model, so the select holds one
			// option even before a Fetch fills the catalog.
			const pseudo: ModelSelectPseudoOption[] = kept
				? [{ label: kept, value: kept }]
				: [{ label: "— select a model —", value: "" }];
			const groups =
				allModels.length > 0
					? oaBuildModelOptionGroups(allModels, this.plugin.settings.modelCategories, kind)
					: [];
			oaPaintModelSelect(selectEl, pseudo, groups);
			selectEl.value = kept;
		};
		this.modelSelectPainters.push(paint);

		new Setting(container)
			.setName(name)
			.setDesc(desc)
			.addDropdown((drop) => {
				selectEl = drop.selectEl;
				paint();
				drop.setValue(saved);
				drop.onChange(async (v) => {
					if (v) await onSave(v);
				});
			})
			.addButton((btn) => {
				btn.setButtonText("Fetch models").onClick(async () => {
					btn.setButtonText("Fetching…").setDisabled(true);
					const models = await oaFetchModelIds(getBaseUrl(), getApiKey(), kind);

					if (models.length === 0) {
						container.empty();
						new Setting(container)
							.setName(name)
							.setDesc(desc)
							.addText((txt) =>
								txt
									.setPlaceholder("")
									.setValue(getValue())
									.onChange(async (v) => {
										await onSave(v.trim());
									}),
							);
						container.createEl("p", {
							text: "Could not fetch models — check URL and API key.",
							cls: "open-agent-notice",
						});
						return;
					}

					btn.setButtonText("Fetch models").setDisabled(false);
					catalog = models;
					// Paint only. A fetch never saves a model, so it cannot switch the
					// user to one they did not choose.
					paint();
				});
			});
	}

	private consentDropdown(parent: HTMLElement, label: string, key: keyof ConsentSettings): void {
		new Setting(parent)
			.setName(label)
			.setDesc(this.consentDesc(key))
			.addDropdown((drop) => {
				drop.addOption("always", "Always allow");
				drop.addOption("ask", "Ask each time");
				drop.addOption("never", "Never allow");
				drop.setValue(this.plugin.settings.consent[key]);
				drop.onChange(async (v) => {
					this.plugin.settings.consent[key] = v as ConsentMode;
					await this.plugin.saveSettings();
				});
			});
	}

	private consentDesc(key: keyof ConsentSettings): string {
		if (key === "vault_read") {
			return "Reads (list, read, search, metadata, links). Default: Always.";
		}
		return "Writes (write, append, edit). Default: Ask. Choose 'Never' to disable mutating tools entirely.";
	}
}
