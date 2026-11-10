import type { ConsentMode, ToolCategory, ToolDef } from "../types";

export interface ConsentSettings {
	vault_read: ConsentMode;
	vault_write: ConsentMode;
}

export const DEFAULT_CONSENT: ConsentSettings = {
	vault_read: "always",
	vault_write: "ask",
};

export type ConsentChoice = "approve" | "reject" | "approve-session";

export class ConsentManager {
	private readonly getSettings: () => ConsentSettings;
	private sessionOverrides: Partial<Record<ToolCategory, ConsentMode>> = {};
	private pending: { id?: string; resolve: (choice: ConsentChoice) => void; category: ToolCategory }[] = [];

	constructor(getSettings: () => ConsentSettings) {
		this.getSettings = getSettings;
	}

	resetSession(): void {
		this.sessionOverrides = {};
	}

	getMode(category: ToolCategory): ConsentMode {
		return this.sessionOverrides[category] ?? this.getSettings()[category];
	}

	resolveConsent(choice: ConsentChoice, id?: string): void {
		const entry = id === undefined ? this.pending.shift() : this.takePendingById(id);
		if (!entry) return;
		if (choice === "approve-session") this.sessionOverrides[entry.category] = "always";
		entry.resolve(choice);
	}

	private takePendingById(id: string) {
		const index = this.pending.findIndex((entry) => entry.id === id);
		if (index === -1) return undefined;
		return this.pending.splice(index, 1)[0];
	}

	cancelPendingConsent(): void {
		const entries = this.pending;
		this.pending = [];
		for (const entry of entries) entry.resolve("reject");
	}

	async requestApproval(tool: ToolDef, _args: unknown, id?: string): Promise<boolean> {
		if (!tool.mutates) return true;
		const mode = this.getMode(tool.category);
		if (mode === "always") return true;
		if (mode === "never") return false;

		const choice = await new Promise<ConsentChoice>((resolve) => {
			this.pending.push({ id, resolve, category: tool.category });
		});
		return choice === "approve" || choice === "approve-session";
	}
}
