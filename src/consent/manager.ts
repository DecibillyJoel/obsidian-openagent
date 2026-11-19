import type { ConsentMode, ToolCategory, ToolDef } from "../types";

export interface ConsentSettings {
	vault_read: ConsentMode;
	vault_write: ConsentMode;
	web: ConsentMode;
}

export const DEFAULT_CONSENT: ConsentSettings = {
	vault_read: "always",
	vault_write: "ask",
	web: "always",
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

	isRefused(category: ToolCategory): boolean {
		return this.getMode(category) === "never";
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
		const mode = this.getMode(tool.category);
		// Only the "never" + non-mutating pair changes. It now refuses the call instead of ignoring the
		// label. "always" and "ask" on a non-mutating tool still approve, because a prompt on every
		// vault read would be hostile.
		if (mode === "never") return false;
		if (!tool.mutates) return true;
		if (mode === "always") return true;

		const choice = await new Promise<ConsentChoice>((resolve) => {
			this.pending.push({ id, resolve, category: tool.category });
		});
		return choice === "approve" || choice === "approve-session";
	}
}
