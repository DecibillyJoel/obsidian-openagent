import Ajv from "ajv";
import type { App } from "obsidian";
import groundedResearchDefault from "./defaults/grounded-research.json";
import { agentPackSchema, type AgentPack } from "./types";

const ajv = new Ajv({ allErrors: true, strict: false });

export class PackValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PackValidationError";
	}
}

export async function ensureDefaultPacks(app: App, pluginDir: string | undefined): Promise<void> {
	if (!pluginDir) return;
	const packDir = `${pluginDir}/packs`;
	if (!(await app.vault.adapter.exists(packDir))) {
		await app.vault.adapter.mkdir(packDir);
	}
	const listing = await app.vault.adapter.list(packDir).catch(() => ({ files: [] as string[] }));
	const jsonFiles = listing.files.filter((file) => file.endsWith(".json"));
	if (jsonFiles.length > 0) return;

	await app.vault.adapter.write(`${packDir}/grounded-research.json`, JSON.stringify(groundedResearchDefault, null, 2));
}

export async function loadPacks(app: App, pluginDir: string | undefined): Promise<AgentPack[]> {
	if (!pluginDir) return [];
	const packDir = `${pluginDir}/packs`;
	if (!(await app.vault.adapter.exists(packDir))) return [];
	const listing = await app.vault.adapter.list(packDir).catch(() => ({ files: [] as string[] }));
	const validate = ajv.compile<AgentPack>(agentPackSchema);
	const packs: AgentPack[] = [];

	for (const path of listing.files.filter((file) => file.endsWith(".json")).sort()) {
		const text = await app.vault.adapter.read(path);
		const parsed = JSON.parse(text) as unknown;
		if (!validate(parsed)) {
			const errors = (validate.errors ?? []).map((error) => `${error.instancePath || "/"} ${error.message ?? "invalid"}`).join("; ");
			throw new PackValidationError(`Invalid pack at ${path}: ${errors}`);
		}
		const pack = parsed;
		assertPackIntegrity(pack, path);
		packs.push(pack);
	}

	return packs;
}

function assertPackIntegrity(pack: AgentPack, path: string): void {
	if (Object.keys(pack.providers).length === 0) {
		throw new PackValidationError(`Invalid pack at ${path}: at least one provider is required`);
	}
	if (Object.keys(pack.agents).length === 0) {
		throw new PackValidationError(`Invalid pack at ${path}: at least one agent is required`);
	}
	for (const [agentId, agent] of Object.entries(pack.agents)) {
		const provider = pack.providers[agent.provider];
		if (!provider) {
			throw new PackValidationError(`Invalid pack at ${path}: agent ${agentId} references missing provider ${agent.provider}`);
		}
		if (!provider.baseUrl.trim() || !provider.model.trim() || !provider.apiKey.trim()) {
			throw new PackValidationError(`Invalid pack at ${path}: provider ${agent.provider} must declare baseUrl, apiKey, and model`);
		}
	}
	for (const step of pack.steps) {
		if (!pack.agents[step.agent]) {
			throw new PackValidationError(`Invalid pack at ${path}: step ${step.id} references missing agent ${step.agent}`);
		}
		if (step.kind === "structured" && step.schema !== "claims-v1") {
			throw new PackValidationError(`Invalid pack at ${path}: step ${step.id} must declare schema claims-v1`);
		}
	}
}
