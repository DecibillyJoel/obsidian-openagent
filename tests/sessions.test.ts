import { describe, expect, it, vi } from "vitest";
import { SessionStore, loadStoredTurnsFile, type StoredTurn } from "../src/sessions";
import { createMockAdapter } from "./setup";

describe("SessionStore", () => {
	it("migrates embedded turns and falls back to the first session when active id is invalid", async () => {
		const persistIndex = vi.fn(async () => undefined);
		const readTurns = vi.fn(async (id: string) => ({ turns: [{ role: "assistant", content: `loaded:${id}` } satisfies StoredTurn] }));
		const writeTurns = vi.fn(async () => undefined);
		const deleteTurns = vi.fn(async () => undefined);
		const store = new SessionStore({ persistIndex, readTurns, writeTurns, deleteTurns });

		await store.init(
			[
				{
					id: "session-a",
					title: "A",
					model: "classic",
					selectedPackId: null,
					lastClassicModel: "classic",
					createdAt: 1,
					updatedAt: 2,
					turns: [{ role: "user", content: "embedded" }],
				},
				{
					id: "session-b",
					title: "B",
					model: "pack",
					selectedPackId: "grounded-research",
					lastClassicModel: "classic",
					createdAt: 3,
					updatedAt: 4,
					turns: [],
				},
			],
			"missing-id",
		);

		expect(writeTurns).toHaveBeenCalledWith("session-a", [{ role: "user", content: "embedded" }]);
		expect(store.getActiveId()).toBe("session-a");
		expect(readTurns).toHaveBeenCalledWith("session-a");
		expect(store.getActive().turns).toEqual([{ role: "assistant", content: "loaded:session-a" }]);
	});

	it("persists turns and index together so pack metadata is retained", async () => {
		const persistIndex = vi.fn(async () => undefined);
		const readTurns = vi.fn(async () => ({ turns: [] }));
		const writeTurns = vi.fn(async () => undefined);
		const deleteTurns = vi.fn(async () => undefined);
		const store = new SessionStore({ persistIndex, readTurns, writeTurns, deleteTurns });

		await store.init(
			[
				{
					id: "session-a",
					title: "A",
					model: "classic",
					selectedPackId: "grounded-research",
					lastClassicModel: "classic",
					createdAt: 1,
					updatedAt: 2,
				},
			],
			"session-a",
		);

		const turns: StoredTurn[] = [
			{ role: "user", content: "Question" },
			{
				role: "assistant",
				content: "",
				packTurn: {
					packId: "grounded-research",
					packName: "Grounded Research",
					verifiedSummary: "- Answer",
					researchMarkdown: "Answer with [1]",
					citations: [
						{
							claimId: "claim-1",
							notePath: "notes/a.md",
							exactPhrase: "Answer",
							startOffset: 0,
							endOffset: "Answer".length,
							occurrenceIndex: 0,
						},
					],
					agentWork: {
						retriever: {
							status: "ready",
							elapsedMs: 120,
							notesFoundCount: 2,
							topNotePaths: ["notes/a.md", "notes/b.md"],
							brief: "- Answer",
						},
						synthesizer: {
							status: "ready",
							elapsedMs: 240,
							claimCount: 1,
							summary: "Answer",
							rawJson: {
								summary: "Answer",
								claims: [
									{
										id: "claim-1",
										text: "Answer",
										source_note: "notes/a.md",
										source_quote: "Answer",
										confidence: 0.9,
									},
								],
							},
						},
						verifier: {
							status: "ready",
							elapsedMs: 360,
							counts: {
								verified: 1,
								unsupported: 0,
								quoteMissing: 0,
							},
							reasons: [
								{
									claimId: "claim-1",
									claimText: "Answer",
									sourceNote: "notes/a.md",
									status: "verified",
									explanation: "Supported",
								},
							],
						},
						run: {
							state: "completed",
							elapsedMs: 720,
							stepElapsedMs: {
								retriever: 120,
								synthesizer: 240,
								verifier: 360,
							},
						},
					},
					claims: [
						{
							id: "claim-1",
							text: "Answer",
							sourceNote: "notes/a.md",
							sourceQuote: "Answer",
							quotePresent: true,
							supportsClaim: true,
							supportExplanation: "Supported",
							status: "verified",
							exactPhraseAnchor: {
								notePath: "notes/a.md",
								exactPhrase: "Answer",
								startOffset: 0,
								endOffset: "Answer".length,
								occurrenceIndex: 0,
							},
						},
					],
				},
			},
		];

		await store.updateTurns("session-a", turns);

		expect(writeTurns).toHaveBeenCalledWith("session-a", turns);
		expect(persistIndex).toHaveBeenCalledTimes(1);
		expect(store.getActive().turns).toEqual(turns);
		expect(store.toJSON()).toEqual({
			sessions: [
				expect.objectContaining({
					id: "session-a",
					selectedPackId: "grounded-research",
					lastClassicModel: "classic",
				}),
			],
			activeSessionId: "session-a",
		});
	});

	it("keeps the agentWork payload optional for legacy and partial-failure pack turns", async () => {
		const persistIndex = vi.fn(async () => undefined);
		const readTurns = vi.fn(async () => ({ turns: [] }));
		const writeTurns = vi.fn(async () => undefined);
		const deleteTurns = vi.fn(async () => undefined);
		const store = new SessionStore({ persistIndex, readTurns, writeTurns, deleteTurns });

		await store.init(
			[
				{
					id: "session-a",
					title: "A",
					model: "classic",
					selectedPackId: "grounded-research",
					lastClassicModel: "classic",
					createdAt: 1,
					updatedAt: 2,
				},
			],
			"session-a",
		);

		const turns: StoredTurn[] = [
			{
				role: "assistant",
				content: "",
				packTurn: {
					packId: "grounded-research",
					packName: "Grounded Research",
					error: "Verifier offline",
					agentWork: {
						retriever: {
							status: "ready",
							elapsedMs: 120,
							notesFoundCount: 1,
							topNotePaths: ["notes/a.md"],
							brief: "- Answer",
						},
						synthesizer: {
							status: "ready",
							elapsedMs: 240,
							claimCount: 1,
							summary: "Answer",
							rawJson: {
								summary: "Answer",
								claims: [
									{
										id: "claim-1",
										text: "Answer",
										source_note: "notes/a.md",
										source_quote: "Answer",
										confidence: 0.9,
									},
								],
							},
						},
						verifier: {
							status: "absent",
							elapsedMs: 90,
						},
						run: {
							state: "failed",
							elapsedMs: 450,
							stepElapsedMs: {
								retriever: 120,
								synthesizer: 240,
								verifier: 90,
							},
							failedStepId: "verifier",
						},
					},
				},
			},
			{
				role: "assistant",
				content: "",
				packTurn: {
					packId: "grounded-research",
					packName: "Grounded Research",
					verifiedSummary: "- Legacy answer",
				},
			},
		];

		await store.updateTurns("session-a", turns);

		expect(writeTurns).toHaveBeenCalledWith("session-a", turns);
		expect(store.getActive().turns[0].packTurn?.agentWork?.verifier.status).toBe("absent");
		expect(store.getActive().turns[1].packTurn?.agentWork).toBeUndefined();
	});

	it("surfaces recovery metadata when turn reads recover from corrupt data", async () => {
		const persistIndex = vi.fn(async () => undefined);
		const recovery = {
			reason: "turns-corrupt" as const,
			message: "Saved chat history was unreadable. OpenAgent moved the original file to sessions/session-a.corrupt-1.json and reset this chat to an empty history.",
			backupPath: "sessions/session-a.corrupt-1.json",
			recoveredAt: 1,
		};
		const readTurns = vi.fn()
			.mockResolvedValueOnce({ turns: [], recovery })
			.mockResolvedValueOnce({ turns: [{ role: "assistant", content: "healthy again" } satisfies StoredTurn] });
		const writeTurns = vi.fn(async () => undefined);
		const deleteTurns = vi.fn(async () => undefined);
		const store = new SessionStore({ persistIndex, readTurns, writeTurns, deleteTurns });

		await store.init(
			[
				{
					id: "session-a",
					title: "A",
					model: "classic",
					selectedPackId: null,
					lastClassicModel: "classic",
					createdAt: 1,
					updatedAt: 2,
				},
			],
			"session-a",
		);

		expect(store.getActive().turns).toEqual([]);
		expect(store.getActive().recovery).toEqual(recovery);

		await store.switchTo("session-a");
		expect(store.getActive().turns).toEqual([{ role: "assistant", content: "healthy again" }]);
		expect(store.getActive().recovery).toBeNull();
	});

	it("remembers the per-session text override and keeps the classic model when the default is selected", async () => {
		const persistIndex = vi.fn(async () => undefined);
		const readTurns = vi.fn(async () => ({ turns: [] }));
		const writeTurns = vi.fn(async () => undefined);
		const deleteTurns = vi.fn(async () => undefined);
		const store = new SessionStore({ persistIndex, readTurns, writeTurns, deleteTurns });

		await store.init(
			[
				{
					id: "session-a",
					title: "A",
					model: "classic",
					selectedPackId: null,
					lastClassicModel: "classic",
					createdAt: 1,
					updatedAt: 2,
				},
			],
			"session-a",
		);

		await store.updateModel("session-a", "override-model");
		expect(store.getActive().textModel).toBe("override-model");
		expect(store.getActive().model).toBe("override-model");
		expect(store.getActive().lastClassicModel).toBe("override-model");

		await store.updateModel("session-a", "");
		expect(store.getActive().textModel).toBe("");
		expect(store.getActive().model).toBe("override-model");
		expect(store.getActive().lastClassicModel).toBe("override-model");
	});

	it("maps a legacy session without textModel to null and seeds new chats with an empty override", async () => {
		const persistIndex = vi.fn(async () => undefined);
		const readTurns = vi.fn(async () => ({ turns: [] }));
		const writeTurns = vi.fn(async () => undefined);
		const deleteTurns = vi.fn(async () => undefined);
		const store = new SessionStore({ persistIndex, readTurns, writeTurns, deleteTurns });

		await store.init(
			[
				{
					id: "session-a",
					title: "A",
					model: "classic",
					selectedPackId: null,
					lastClassicModel: "classic",
					createdAt: 1,
					updatedAt: 2,
				},
			],
			"session-a",
		);
		expect(store.getActive().textModel).toBeNull();

		const created = await store.create();
		expect(created.textModel).toBe("");
	});
});

describe("loadStoredTurnsFile", () => {
	it("loads valid turn files without recovery metadata", async () => {
		const adapter = createMockAdapter({
			"sessions/session-a.json": JSON.stringify({
				turns: [{ role: "assistant", content: "loaded" } satisfies StoredTurn],
			}),
		});

		const result = await loadStoredTurnsFile({
			adapter,
			path: "sessions/session-a.json",
			now: () => 123,
		});

		expect(result).toEqual({
			turns: [{ role: "assistant", content: "loaded" }],
		});
		expect(adapter.rename).not.toHaveBeenCalled();
		expect(adapter.write).not.toHaveBeenCalled();
	});

	it("loads legacy turns without agentWork and preserves newer payloads unchanged", async () => {
		const adapter = createMockAdapter({
			"sessions/session-a.json": JSON.stringify({
				turns: [
					{
						role: "assistant",
						content: "legacy",
						packTurn: {
							packId: "grounded-research",
							packName: "Grounded Research",
							verifiedSummary: "- Legacy answer",
						},
					},
					{
						role: "assistant",
						content: "partial",
						packTurn: {
							packId: "grounded-research",
							packName: "Grounded Research",
							error: "Verifier offline",
							agentWork: {
								retriever: {
									status: "ready",
									elapsedMs: 120,
									notesFoundCount: 1,
									topNotePaths: ["notes/a.md"],
									brief: "- Answer",
								},
								synthesizer: {
									status: "ready",
									elapsedMs: 240,
									claimCount: 1,
									summary: "Answer",
									rawJson: {
										summary: "Answer",
										claims: [
											{
												id: "claim-1",
												text: "Answer",
												source_note: "notes/a.md",
												source_quote: "Answer",
												confidence: 0.9,
											},
										],
									},
								},
								verifier: {
									status: "absent",
									elapsedMs: 90,
								},
								run: {
									state: "failed",
									elapsedMs: 450,
									stepElapsedMs: {
										retriever: 120,
										synthesizer: 240,
										verifier: 90,
									},
									failedStepId: "verifier",
								},
							},
						},
					},
				],
			}),
		});

		const result = await loadStoredTurnsFile({
			adapter,
			path: "sessions/session-a.json",
			now: () => 789,
		});

		expect(result.turns[0].packTurn?.agentWork).toBeUndefined();
		expect(result.turns[1].packTurn?.agentWork?.run).toEqual({
			state: "failed",
			elapsedMs: 450,
			stepElapsedMs: {
				retriever: 120,
				synthesizer: 240,
				verifier: 90,
			},
			failedStepId: "verifier",
		});
	});

	it("drops malformed agentWork payloads while keeping the rest of the turn readable", async () => {
		const adapter = createMockAdapter({
			"sessions/session-a.json": JSON.stringify({
				turns: [
					{
						role: "assistant",
						content: "partial",
						packTurn: {
							packId: "grounded-research",
							packName: "Grounded Research",
							error: "Verifier offline",
							agentWork: {
								retriever: "bad",
								synthesizer: null,
								verifier: { status: "ready" },
								run: { state: "failed", elapsedMs: "fast" },
							},
						},
					},
				],
			}),
		});

		const result = await loadStoredTurnsFile({
			adapter,
			path: "sessions/session-a.json",
			now: () => 790,
		});

		expect(result.turns).toEqual([
			{
				role: "assistant",
				content: "partial",
				packTurn: {
					packId: "grounded-research",
					packName: "Grounded Research",
					error: "Verifier offline",
				},
			},
		]);
	});

	it("drops malformed anchor and citation payloads while keeping the rest of the turn readable", async () => {
		const adapter = createMockAdapter({
			"sessions/session-a.json": JSON.stringify({
				turns: [
					{
						role: "assistant",
						content: "partial",
						packTurn: {
							packId: "grounded-research",
							packName: "Grounded Research",
							verifiedSummary: "- Answer",
							researchMarkdown: "Answer with [1]",
							citations: [
								{
									claimId: "claim-1",
									notePath: "notes/a.md",
									exactPhrase: "Answer",
									startOffset: "zero",
									endOffset: 6,
									occurrenceIndex: 0,
								},
							],
							claims: [
								{
									id: "claim-1",
									text: "Answer",
									sourceNote: "notes/a.md",
									sourceQuote: "Answer",
									quotePresent: true,
									supportsClaim: true,
									supportExplanation: "Supported",
									status: "verified",
									exactPhraseAnchor: {
										notePath: "notes/a.md",
										exactPhrase: "Answer",
										startOffset: "zero",
										endOffset: 6,
										occurrenceIndex: 0,
									},
								},
							],
						},
					},
				],
			}),
		});

		const result = await loadStoredTurnsFile({
			adapter,
			path: "sessions/session-a.json",
			now: () => 791,
		});

		expect(result.turns).toEqual([
			{
				role: "assistant",
				content: "partial",
				packTurn: {
					packId: "grounded-research",
					packName: "Grounded Research",
					verifiedSummary: "- Answer",
					researchMarkdown: "Answer with [1]",
					claims: [
						{
							id: "claim-1",
							text: "Answer",
							sourceNote: "notes/a.md",
							sourceQuote: "Answer",
							quotePresent: true,
							supportsClaim: true,
							supportExplanation: "Supported",
							status: "verified",
						},
					],
				},
			},
		]);
	});

	it("backs up corrupt turn files and resets the active file to empty turns", async () => {
		const adapter = createMockAdapter({
			"sessions/session-a.json": "{not valid json",
		});

		const result = await loadStoredTurnsFile({
			adapter,
			path: "sessions/session-a.json",
			now: () => 123,
		});

		expect(result.recovery).toEqual({
			reason: "turns-corrupt",
			backupPath: "sessions/session-a.corrupt-123.json",
			recoveredAt: 123,
			message: "Saved chat history was unreadable. OpenAgent moved the original file to sessions/session-a.corrupt-123.json and reset this chat to an empty history.",
		});
		expect(result.turns).toEqual([]);
		expect(adapter.rename).toHaveBeenCalledWith(
			"sessions/session-a.json",
			"sessions/session-a.corrupt-123.json",
		);
		expect(adapter.write).toHaveBeenCalledWith(
			"sessions/session-a.json",
			JSON.stringify({ turns: [] }),
		);
		expect(await adapter.read("sessions/session-a.corrupt-123.json")).toBe("{not valid json");
		expect(await adapter.read("sessions/session-a.json")).toBe(JSON.stringify({ turns: [] }));
	});

	it("treats non-array turn payloads as corrupt and recovers visibly", async () => {
		const adapter = createMockAdapter({
			"sessions/session-a.json": JSON.stringify({ turns: null }),
		});

		const result = await loadStoredTurnsFile({
			adapter,
			path: "sessions/session-a.json",
			now: () => 456,
		});

		expect(result.recovery?.backupPath).toBe("sessions/session-a.corrupt-456.json");
		expect(await adapter.read("sessions/session-a.corrupt-456.json")).toBe(JSON.stringify({ turns: null }));
		expect(await adapter.read("sessions/session-a.json")).toBe(JSON.stringify({ turns: [] }));
	});
});
