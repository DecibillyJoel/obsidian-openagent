import { describe, expect, it } from "vitest";
import { ConsentManager } from "../../src/consent/manager";
import type { ToolDef } from "../../src/types";

function toolNamed(name: string): ToolDef {
	return {
		name,
		description: name,
		schema: { type: "object", properties: {}, additionalProperties: true },
		category: "vault_write",
		mutates: true,
		run: async () => ({ ok: true as const, value: null }),
	};
}

function askingManager(): ConsentManager {
	return new ConsentManager(() => ({ vault_read: "always", vault_write: "ask" }));
}

interface Observation {
	settled: () => boolean;
	value: () => boolean | undefined;
}

function observe(promise: Promise<boolean>): Observation {
	let settled = false;
	let value: boolean | undefined;
	void promise.then((resolved) => {
		settled = true;
		value = resolved;
	});
	return { settled: () => settled, value: () => value };
}

async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

describe("ConsentManager request queue", () => {
	it("queues a second approval request instead of replacing the first", async () => {
		const manager = askingManager();
		const first = manager.requestApproval(toolNamed("vault_write"), {});
		const second = manager.requestApproval(toolNamed("vault_delete"), {});
		manager.resolveConsent("reject");
		expect(await first).toBe(false);
		manager.resolveConsent("approve");
		expect(await second).toBe(true);
	});

	it("resolves only the request the caller names", async () => {
		const manager = askingManager();
		const first = observe(manager.requestApproval(toolNamed("vault_write"), {}, "call-a"));
		const second = observe(manager.requestApproval(toolNamed("vault_delete"), {}, "call-b"));
		manager.resolveConsent("approve", "call-b");
		await flushMicrotasks();
		expect(second.settled()).toBe(true);
		expect(second.value()).toBe(true);
		expect(first.settled()).toBe(false);
		manager.resolveConsent("approve", "call-a");
		await flushMicrotasks();
		expect(first.settled()).toBe(true);
		expect(first.value()).toBe(true);
	});

	it("ignores an id it does not hold", async () => {
		const manager = askingManager();
		const first = observe(manager.requestApproval(toolNamed("vault_write"), {}, "call-a"));
		manager.resolveConsent("approve", "call-z");
		await flushMicrotasks();
		expect(first.settled()).toBe(false);
		manager.resolveConsent("approve", "call-a");
		await flushMicrotasks();
		expect(first.settled()).toBe(true);
		expect(first.value()).toBe(true);
	});

	it("still resolves in order when no id is given", async () => {
		const manager = askingManager();
		const first = observe(manager.requestApproval(toolNamed("vault_write"), {}));
		const second = observe(manager.requestApproval(toolNamed("vault_delete"), {}));
		manager.resolveConsent("reject");
		await flushMicrotasks();
		expect(first.settled()).toBe(true);
		expect(first.value()).toBe(false);
		expect(second.settled()).toBe(false);
		manager.resolveConsent("approve");
		await flushMicrotasks();
		expect(second.settled()).toBe(true);
		expect(second.value()).toBe(true);
	});

	it("cancels every queued request when consent is cancelled", async () => {
		const manager = askingManager();
		const first = manager.requestApproval(toolNamed("vault_write"), {}, "call-a");
		const second = manager.requestApproval(toolNamed("vault_delete"), {}, "call-b");
		manager.cancelPendingConsent();
		expect(await first).toBe(false);
		expect(await second).toBe(false);
	});
});
