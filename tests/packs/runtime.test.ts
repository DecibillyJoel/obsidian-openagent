import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import rawGroundedResearchDefault from "../../src/packs/defaults/grounded-research.json";
import { createMockApp } from "../setup";
import type { PackRunFailure } from "../../src/packs/runtime";
import type { AgentPack } from "../../src/packs/types";

const groundedResearchDefault = rawGroundedResearchDefault as unknown as AgentPack;

const retrieveEvidenceMock = vi.fn();
const verifyClaimsMock = vi.fn();
const providerStreams: string[] = [];

vi.mock("../../src/agents/retrieval", async () => {
	const actual = await vi.importActual<typeof import("../../src/agents/retrieval")>("../../src/agents/retrieval");
	return {
		...actual,
		retrieveEvidence: retrieveEvidenceMock,
	};
});

vi.mock("../../src/agents/verifier", () => ({
	verifyClaims: verifyClaimsMock,
}));

vi.mock("../../src/provider", () => ({
	OpenAICompatibleProvider: class {
		config: { model: string };

		constructor(config: { model: string }) {
			this.config = config;
		}

		async *stream() {
			yield { kind: "text", text: providerStreams.shift() ?? "" };
			yield { kind: "done", finishReason: "stop" };
		}
	},
}));

describe("runPack", () => {
	beforeEach(() => {
		providerStreams.length = 0;
		retrieveEvidenceMock.mockReset();
		verifyClaimsMock.mockReset();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("runs shared runtime logic for verified and verifier-disabled eval paths", async () => {
		retrieveEvidenceMock.mockResolvedValue({
			query: "What happened?",
			scope: { notePaths: [], folders: [], tags: [] },
			notes: [
				{
					path: "notes/a.md",
					title: "a",
					content: "Alpha fact",
					excerpt: "Alpha fact",
					score: 5,
				},
			],
		});
		verifyClaimsMock.mockResolvedValue([
			{
				id: "claim-1",
				text: "Alpha fact",
				sourceNote: "notes/a.md",
				sourceQuote: "Alpha fact",
				quotePresent: true,
				supportsClaim: true,
				supportExplanation: "Matches note text",
				status: "verified",
				exactPhraseAnchor: {
					notePath: "notes/a.md",
					exactPhrase: "Alpha fact",
					startOffset: 0,
					endOffset: "Alpha fact".length,
					occurrenceIndex: 0,
				},
			},
			{
				id: "claim-2",
				text: "Missing fact",
				sourceNote: "notes/a.md",
				sourceQuote: "Missing fact",
				quotePresent: false,
				supportsClaim: null,
				supportExplanation: "Quote missing",
				status: "quote-missing",
			},
		]);
		providerStreams.push(
			"- Alpha fact (notes/a.md)",
			JSON.stringify({
				summary: "Alpha summary",
				claims: [
					{
						id: "claim-1",
						text: "Alpha fact",
						source_note: "notes/a.md",
						source_quote: "Alpha fact",
						confidence: 0.9,
					},
					{
						id: "claim-2",
						text: "Missing fact",
						source_note: "notes/a.md",
						source_quote: "Missing fact",
						confidence: 0.2,
					},
				],
			}),
		);

		const { runPack, runPackForEval } = await import("../../src/packs/runtime");
		const events: Array<Record<string, unknown>> = [];
		const app = createMockApp({
			files: {
				"notes/a.md": "Alpha fact",
			},
		});

		const result = await runPack({
			app: app as never,
			pack: groundedResearchDefault,
			query: "What happened?",
			onEvent: async (event) => {
				events.push(event as unknown as Record<string, unknown>);
			},
		});
		expect(result.artifacts).toEqual({
			verifierEnabled: true,
			retrieval: {
				brief: "- Alpha fact (notes/a.md)",
				notes: [
					{
						path: "notes/a.md",
						title: "a",
						content: "Alpha fact",
						excerpt: "Alpha fact",
						score: 5,
					},
				],
			},
			draftClaims: {
				summary: "Alpha summary",
				claims: [
					{
						id: "claim-1",
						text: "Alpha fact",
						source_note: "notes/a.md",
						source_quote: "Alpha fact",
						confidence: 0.9,
					},
					{
						id: "claim-2",
						text: "Missing fact",
						source_note: "notes/a.md",
						source_quote: "Missing fact",
						confidence: 0.2,
					},
				],
			},
			verifications: result.claims,
		});
		expect(retrieveEvidenceMock).toHaveBeenCalledOnce();
		expect(verifyClaimsMock).toHaveBeenCalledOnce();
		expect(result).toEqual({
			packId: "grounded-research",
			packName: "Grounded Research",
			verifiedSummary: "- Alpha fact",
			researchMarkdown: "Alpha fact [1](openagent://citation/1)",
			citations: [
				{
					claimId: "claim-1",
					notePath: "notes/a.md",
					exactPhrase: "Alpha fact",
					startOffset: 0,
					endOffset: "Alpha fact".length,
					occurrenceIndex: 0,
				},
			],
			claims: [
				{
					id: "claim-1",
					text: "Alpha fact",
					sourceNote: "notes/a.md",
					sourceQuote: "Alpha fact",
					quotePresent: true,
					supportsClaim: true,
					supportExplanation: "Matches note text",
					status: "verified",
					exactPhraseAnchor: {
						notePath: "notes/a.md",
						exactPhrase: "Alpha fact",
						startOffset: 0,
						endOffset: "Alpha fact".length,
						occurrenceIndex: 0,
					},
				},
				{
					id: "claim-2",
					text: "Missing fact",
					sourceNote: "notes/a.md",
					sourceQuote: "Missing fact",
					quotePresent: false,
					supportsClaim: null,
					supportExplanation: "Quote missing",
					status: "quote-missing",
				},
			],
			modelsUsed: {
				retriever: groundedResearchDefault.providers.retriever.model,
				synthesizer: groundedResearchDefault.providers.synthesizer.model,
				verifier: groundedResearchDefault.providers.verifier.model,
			},
			artifacts: expect.any(Object),
			transparency: expect.any(Object),
		});
		expect(events).toEqual([
			{ kind: "step", step: { id: "retriever", label: "Retrieving notes", state: "pending", message: undefined } },
			{ kind: "step", step: { id: "synthesizer", label: "Drafting claims", state: "pending", message: undefined } },
			{ kind: "step", step: { id: "verifier", label: "Verifying claims", state: "pending", message: undefined } },
			{ kind: "step", step: { id: "retriever", label: "Retrieving notes", state: "running", message: undefined } },
			expect.objectContaining({
				kind: "step",
				step: { id: "retriever", label: "Retrieving notes", state: "complete", message: undefined },
				agentWork: expect.objectContaining({
					retriever: expect.objectContaining({ status: "ready" }),
				}),
			}),
			{ kind: "step", step: { id: "synthesizer", label: "Drafting claims", state: "running", message: undefined } },
			expect.objectContaining({
				kind: "step",
				step: { id: "synthesizer", label: "Drafting claims", state: "complete", message: undefined },
				agentWork: expect.objectContaining({
					synthesizer: expect.objectContaining({ status: "ready" }),
				}),
			}),
			{ kind: "step", step: { id: "verifier", label: "Verifying claims", state: "running", message: undefined } },
			expect.objectContaining({
				kind: "step",
				step: { id: "verifier", label: "Verifying claims", state: "complete", message: undefined },
				agentWork: expect.objectContaining({
					verifier: expect.objectContaining({ status: "ready" }),
				}),
			}),
		]);

		verifyClaimsMock.mockClear();
		providerStreams.push(
			"- Alpha fact (notes/a.md)",
			JSON.stringify({
				summary: "Alpha summary",
				claims: [
					{
						id: "claim-1",
						text: "Alpha fact",
						source_note: "notes/a.md",
						source_quote: "Alpha fact",
						confidence: 0.9,
					},
				],
			}),
		);

		const baseline = await runPackForEval({
			app: app as never,
			pack: groundedResearchDefault,
			query: "What happened?",
			verifierEnabled: false,
		});

		expect(verifyClaimsMock).not.toHaveBeenCalled();
		expect(baseline.claims).toEqual([]);
		expect(baseline.verifiedSummary).toBe("Alpha summary");
		expect(baseline.artifacts).toEqual({
			verifierEnabled: false,
			retrieval: {
				brief: "- Alpha fact (notes/a.md)",
				notes: [
					{
						path: "notes/a.md",
						title: "a",
						content: "Alpha fact",
						excerpt: "Alpha fact",
						score: 5,
					},
				],
			},
			draftClaims: {
				summary: "Alpha summary",
				claims: [
					{
						id: "claim-1",
						text: "Alpha fact",
						source_note: "notes/a.md",
						source_quote: "Alpha fact",
						confidence: 0.9,
					},
				],
			},
			verifications: null,
		});
		expect(baseline.transparency.verifier.status).toBe("absent");
		expect(baseline.researchMarkdown).toBeUndefined();
		expect(baseline.citations).toBeUndefined();
	});

	it("reuses citation labels when the same anchored phrase is verified across multiple claims", async () => {
		retrieveEvidenceMock.mockResolvedValue({
			query: "What happened?",
			scope: { notePaths: [], folders: [], tags: [] },
			notes: [
				{
					path: "notes/a.md",
					title: "a",
					content: "Alpha fact",
					excerpt: "Alpha fact",
					score: 5,
				},
			],
		});
		const repeatedAnchor = {
			notePath: "notes/a.md",
			exactPhrase: "Alpha fact",
			startOffset: 0,
			endOffset: "Alpha fact".length,
			occurrenceIndex: 0,
		};
		verifyClaimsMock.mockResolvedValue([
			{
				id: "claim-1",
				text: "Alpha fact",
				sourceNote: "notes/a.md",
				sourceQuote: "Alpha fact",
				quotePresent: true,
				supportsClaim: true,
				supportExplanation: "Matches note text",
				status: "verified",
				exactPhraseAnchor: repeatedAnchor,
			},
			{
				id: "claim-2",
				text: "Alpha remained on schedule",
				sourceNote: "notes/a.md",
				sourceQuote: "Alpha fact",
				quotePresent: true,
				supportsClaim: true,
				supportExplanation: "Same supporting phrase",
				status: "verified",
				exactPhraseAnchor: repeatedAnchor,
			},
		]);
		providerStreams.push(
			"- Alpha fact (notes/a.md)",
			JSON.stringify({
				summary: "Alpha summary",
				claims: [
					{
						id: "claim-1",
						text: "Alpha fact",
						source_note: "notes/a.md",
						source_quote: "Alpha fact",
						confidence: 0.9,
					},
					{
						id: "claim-2",
						text: "Alpha remained on schedule",
						source_note: "notes/a.md",
						source_quote: "Alpha fact",
						confidence: 0.8,
					},
				],
			}),
		);

		const { runPack } = await import("../../src/packs/runtime");
		const app = createMockApp({
			files: {
				"notes/a.md": "Alpha fact",
			},
		});

		const result = await runPack({
			app: app as never,
			pack: groundedResearchDefault,
			query: "What happened?",
		});

		expect(result.verifiedSummary).toBe("- Alpha fact\n- Alpha remained on schedule");
		expect(result.researchMarkdown).toBe(
			"Alpha fact [1](openagent://citation/1)\n\nAlpha remained on schedule [1](openagent://citation/1)",
		);
		expect(result.citations).toEqual([
			{
				claimId: "claim-1",
				...repeatedAnchor,
			},
		]);
	});

	it("leaves citation-ready fields absent when verified claims have no exact anchors", async () => {
		retrieveEvidenceMock.mockResolvedValue({
			query: "What happened?",
			scope: { notePaths: [], folders: [], tags: [] },
			notes: [
				{
					path: "notes/a.md",
					title: "a",
					content: "Alpha fact",
					excerpt: "Alpha fact",
					score: 5,
				},
			],
		});
		verifyClaimsMock.mockResolvedValue([
			{
				id: "claim-1",
				text: "Alpha fact",
				sourceNote: "notes/a.md",
				sourceQuote: "Alpha fact",
				quotePresent: true,
				supportsClaim: true,
				supportExplanation: "Matches note text",
				status: "verified",
			},
		]);
		providerStreams.push(
			"- Alpha fact (notes/a.md)",
			JSON.stringify({
				summary: "Alpha summary",
				claims: [
					{
						id: "claim-1",
						text: "Alpha fact",
						source_note: "notes/a.md",
						source_quote: "Alpha fact",
						confidence: 0.9,
					},
				],
			}),
		);

		const { runPack } = await import("../../src/packs/runtime");
		const app = createMockApp({
			files: {
				"notes/a.md": "Alpha fact",
			},
		});

		const result = await runPack({
			app: app as never,
			pack: groundedResearchDefault,
			query: "What happened?",
		});

		expect(result.verifiedSummary).toBe("- Alpha fact");
		expect(result.researchMarkdown).toBeUndefined();
		expect(result.citations).toBeUndefined();
	});

	it("rejects placeholder provider credentials before pack execution begins", async () => {
		const { runPack, PackConfigError } = await import("../../src/packs/runtime");
		const app = createMockApp({
			files: {
				"notes/a.md": "Alpha fact",
			},
		});
		const placeholderPack = structuredClone(groundedResearchDefault);
		placeholderPack.id = "placeholder-pack";
		placeholderPack.providers.retriever.apiKey = "replace-me";

		await expect(
			runPack({
				app: app as never,
				pack: placeholderPack,
				query: "What happened?",
			}),
		).rejects.toThrow(PackConfigError);
		await expect(
			runPack({
				app: app as never,
				pack: placeholderPack,
				query: "What happened?",
			}),
		).rejects.toThrow(
			'Pack placeholder-pack provider retriever still uses the placeholder API key "replace-me"',
		);
		expect(retrieveEvidenceMock).not.toHaveBeenCalled();
	});

	it("resolves provider mappings from pack json without requiring hardcoded provider ids", async () => {
		retrieveEvidenceMock.mockResolvedValue({
			query: "What happened?",
			scope: { notePaths: [], folders: [], tags: [] },
			notes: [
				{
					path: "notes/a.md",
					title: "a",
					content: "Alpha fact",
					excerpt: "Alpha fact",
					score: 5,
				},
			],
		});
		verifyClaimsMock.mockResolvedValue([
			{
				id: "claim-1",
				text: "Alpha fact",
				sourceNote: "notes/a.md",
				sourceQuote: "Alpha fact",
				quotePresent: true,
				supportsClaim: true,
				supportExplanation: "Matches note text",
				status: "verified",
			},
		]);
		providerStreams.push(
			"- Alpha fact (notes/a.md)",
			JSON.stringify({
				summary: "Alpha summary",
				claims: [
					{
						id: "claim-1",
						text: "Alpha fact",
						source_note: "notes/a.md",
						source_quote: "Alpha fact",
						confidence: 0.9,
					},
				],
			}),
		);

		const customPack = structuredClone(groundedResearchDefault);
		customPack.providers = {
			fast: {
				baseUrl: "http://retriever.local/v1",
				apiKey: "mlx-local",
				model: "retriever-model",
			},
			deep: {
				baseUrl: "http://synth.local/v1",
				apiKey: "mlx-local",
				model: "synth-model",
			},
			judge: {
				baseUrl: "http://verifier.local/v1",
				apiKey: "mlx-local",
				model: "verifier-model",
			},
		};
		customPack.agents.retriever.provider = "fast";
		customPack.agents.synthesizer.provider = "deep";
		customPack.agents.verifier.provider = "judge";

		const providerFactory = vi.fn((config: { model: string }, _agentId: string) => ({
			stream: async function* () {
				yield { kind: "text" as const, text: providerStreams.shift() ?? "" };
				yield { kind: "done" as const, finishReason: "stop" as const };
			},
			config,
		}));

		const { runPack } = await import("../../src/packs/runtime");
		const app = createMockApp({
			files: {
				"notes/a.md": "Alpha fact",
			},
		});

		const result = await runPack({
			app: app as never,
			pack: customPack,
			query: "What happened?",
			providerFactory,
		});

		expect(providerFactory.mock.calls.map(([config, agentId]) => [agentId, config.model])).toEqual([
			["retriever", "retriever-model"],
			["synthesizer", "synth-model"],
			["verifier", "verifier-model"],
		]);
		expect(result.modelsUsed).toEqual({
			retriever: "retriever-model",
			synthesizer: "synth-model",
			verifier: "verifier-model",
		});
		expect(Object.values(groundedResearchDefault.agents).every((agent) => !agent.toolAllowlist || agent.toolAllowlist.length === 0)).toBe(true);
	});

	it("returns sanitized transparency snapshots and elapsedMs values for completed runs", async () => {
		retrieveEvidenceMock.mockResolvedValue({
			query: "What happened?",
			scope: { notePaths: [], folders: [], tags: [] },
			notes: [
				{
					path: "notes/a.md",
					title: "a",
					content: "Alpha fact",
					excerpt: "Alpha fact",
					score: 5,
				},
				{
					path: "notes/b.md",
					title: "b",
					content: "Beta fact",
					excerpt: "Beta fact",
					score: 4,
				},
			],
		});
		verifyClaimsMock.mockResolvedValue([
			{
				id: "claim-1",
				text: "Alpha fact",
				sourceNote: "notes/a.md",
				sourceQuote: "Alpha fact",
				quotePresent: true,
				supportsClaim: true,
				supportExplanation: "Matches note text",
				status: "verified",
			},
			{
				id: "claim-2",
				text: "Beta fact",
				sourceNote: "notes/b.md",
				sourceQuote: "Beta fact",
				quotePresent: true,
				supportsClaim: false,
				supportExplanation: "Source is weaker than the claim",
				status: "unsupported",
			},
			{
				id: "claim-3",
				text: "Missing fact",
				sourceNote: "notes/c.md",
				sourceQuote: "Missing fact",
				quotePresent: false,
				supportsClaim: null,
				supportExplanation: "Quote missing",
				status: "quote-missing",
			},
		]);
		providerStreams.push(
			"- Alpha fact (notes/a.md)\n- Beta fact (notes/b.md)",
			JSON.stringify({
				summary: "Alpha summary",
				claims: [
					{
						id: "claim-1",
						text: "Alpha fact",
						source_note: "notes/a.md",
						source_quote: "Alpha fact",
						confidence: 0.9,
					},
					{
						id: "claim-2",
						text: "Beta fact",
						source_note: "notes/b.md",
						source_quote: "Beta fact",
						confidence: 0.6,
					},
					{
						id: "claim-3",
						text: "Missing fact",
						source_note: "notes/c.md",
						source_quote: "Missing fact",
						confidence: 0.2,
					},
				],
			}),
		);

		const timestamps = [1000, 1100, 1300, 1400, 1700, 1800, 2300];
		let timestampIndex = 0;
		vi.spyOn(Date, "now").mockImplementation(() => timestamps[Math.min(timestampIndex++, timestamps.length - 1)]);

		const { runPack } = await import("../../src/packs/runtime");
		const events: Array<Record<string, unknown>> = [];
		const app = createMockApp({
			files: {
				"notes/a.md": "Alpha fact",
				"notes/b.md": "Beta fact",
			},
		});

		const result = await runPack({
			app: app as never,
			pack: groundedResearchDefault,
			query: "What happened?",
			onEvent: async (event) => {
				events.push(event as unknown as Record<string, unknown>);
			},
		});

		expect(result.transparency).toEqual({
			retriever: {
				status: "ready",
				elapsedMs: 200,
				notesFoundCount: 2,
				topNotePaths: ["notes/a.md", "notes/b.md"],
				brief: "- Alpha fact (notes/a.md)\n- Beta fact (notes/b.md)",
			},
			synthesizer: {
				status: "ready",
				elapsedMs: 300,
				claimCount: 3,
				summary: "Alpha summary",
				rawJson: {
					summary: "Alpha summary",
					claims: [
						expect.objectContaining({ id: "claim-1" }),
						expect.objectContaining({ id: "claim-2" }),
						expect.objectContaining({ id: "claim-3" }),
					],
				},
			},
			verifier: {
				status: "ready",
				elapsedMs: 500,
				counts: {
					verified: 1,
					unsupported: 1,
					quoteMissing: 1,
				},
				reasons: [
					{
						claimId: "claim-1",
						claimText: "Alpha fact",
						sourceNote: "notes/a.md",
						status: "verified",
						explanation: "Matches note text",
					},
					{
						claimId: "claim-2",
						claimText: "Beta fact",
						sourceNote: "notes/b.md",
						status: "unsupported",
						explanation: "Source is weaker than the claim",
					},
					{
						claimId: "claim-3",
						claimText: "Missing fact",
						sourceNote: "notes/c.md",
						status: "quote-missing",
						explanation: "Quote missing",
					},
				],
			},
			run: {
				state: "completed",
				elapsedMs: 1300,
				stepElapsedMs: {
					retriever: 200,
					synthesizer: 300,
					verifier: 500,
				},
			},
		});
		expect(result.transparency.retriever).not.toHaveProperty("notes");
		expect(result.transparency.retriever).not.toHaveProperty("content");
		expect(result.transparency.retriever).not.toHaveProperty("score");
		expect(result.transparency.synthesizer).not.toHaveProperty("prompt");
		expect(result.transparency.verifier.reasons?.[0]).not.toHaveProperty("sourceQuote");
		expect(result.modelsUsed).toEqual({
			retriever: groundedResearchDefault.providers.retriever.model,
			synthesizer: groundedResearchDefault.providers.synthesizer.model,
			verifier: groundedResearchDefault.providers.verifier.model,
		});

		const snapshotEvents = events.filter((event) => event.kind === "step" && "agentWork" in event);
		expect(snapshotEvents).toEqual([
			expect.objectContaining({
				kind: "step",
				step: expect.objectContaining({ id: "retriever", state: "complete" }),
				agentWork: expect.objectContaining({
					retriever: expect.objectContaining({
						status: "ready",
						elapsedMs: 200,
						notesFoundCount: 2,
					}),
					synthesizer: expect.objectContaining({ status: "pending" }),
					verifier: expect.objectContaining({ status: "pending" }),
					run: expect.objectContaining({ state: "running", elapsedMs: 300 }),
				}),
			}),
			expect.objectContaining({
				kind: "step",
				step: expect.objectContaining({ id: "synthesizer", state: "complete" }),
				agentWork: expect.objectContaining({
					synthesizer: expect.objectContaining({
						status: "ready",
						elapsedMs: 300,
						claimCount: 3,
					}),
					verifier: expect.objectContaining({ status: "pending" }),
					run: expect.objectContaining({ state: "running", elapsedMs: 700 }),
				}),
			}),
			expect.objectContaining({
				kind: "step",
				step: expect.objectContaining({ id: "verifier", state: "complete" }),
				agentWork: expect.objectContaining({
					verifier: expect.objectContaining({
						status: "ready",
						elapsedMs: 500,
						counts: { verified: 1, unsupported: 1, quoteMissing: 1 },
					}),
					run: expect.objectContaining({ state: "completed", elapsedMs: 1300 }),
				}),
			}),
		]);
	});

	it("does not report verifier as failedStepId when verifierEnabled is false and retriever fails", async () => {
		// retriever throws — failedStepId will be "retriever" (set by step event handler)
		// But this test verifies: when verifierEnabled=false, failure never blames "verifier"
		retrieveEvidenceMock.mockRejectedValueOnce(new Error("network failure"));

		let caughtFailure: import("../../src/packs/runtime").PackRunFailure | undefined;
		try {
			const { runPackForEval } = await import("../../src/packs/runtime");
			await runPackForEval({
				pack: groundedResearchDefault,
				query: "test",
				app: createMockApp() as never,
				verifierEnabled: false,
			});
		} catch (error) {
			const { PackRunError } = await import("../../src/packs/runtime");
			if (error instanceof PackRunError) caughtFailure = error.failure;
		}

		expect(caughtFailure).toBeDefined();
		expect(caughtFailure?.failedStepId).not.toBe("verifier");
		expect(caughtFailure?.failedStepId).toBe("retriever");
	});

	it("reports synthesizer as failedStepId when verifierEnabled is false and synthesizer fails", async () => {
		retrieveEvidenceMock.mockResolvedValueOnce({
			query: "test",
			scope: { notePaths: [], folders: [], tags: [] },
			notes: [],
		});
		// Push a valid brief for the retriever's streaming call,
		// leave synthesizer stream empty so structured step fails
		providerStreams.push("Brief: no notes found.");

		let caughtFailure: PackRunFailure | undefined;
		try {
			const { runPackForEval } = await import("../../src/packs/runtime");
			await runPackForEval({
				pack: groundedResearchDefault,
				query: "test",
				app: createMockApp() as never,
				verifierEnabled: false,
			});
		} catch (error) {
			const { PackRunError } = await import("../../src/packs/runtime");
			if (error instanceof PackRunError) caughtFailure = error.failure;
		}

		expect(caughtFailure).toBeDefined();
		// lastStepId is "synthesizer" when verifierEnabled=false
		expect(caughtFailure?.failedStepId).toBe("synthesizer");
		expect(caughtFailure?.failedStepId).not.toBe("verifier");
	});

	it("throws partial transparency data for failed runs", async () => {
		retrieveEvidenceMock.mockResolvedValue({
			query: "What happened?",
			scope: { notePaths: [], folders: [], tags: [] },
			notes: [
				{
					path: "notes/a.md",
					title: "a",
					content: "Alpha fact",
					excerpt: "Alpha fact",
					score: 5,
				},
			],
		});
		verifyClaimsMock.mockRejectedValue(new Error("Verifier offline"));
		providerStreams.push(
			"- Alpha fact (notes/a.md)",
			JSON.stringify({
				summary: "Alpha summary",
				claims: [
					{
						id: "claim-1",
						text: "Alpha fact",
						source_note: "notes/a.md",
						source_quote: "Alpha fact",
						confidence: 0.9,
					},
				],
			}),
		);

		const timestamps = [1000, 1100, 1300, 1400, 1700, 1800, 1900];
		let timestampIndex = 0;
		vi.spyOn(Date, "now").mockImplementation(() => timestamps[Math.min(timestampIndex++, timestamps.length - 1)]);

		const { PackRunError, runPack } = await import("../../src/packs/runtime");
		const events: Array<Record<string, unknown>> = [];
		const app = createMockApp({
			files: {
				"notes/a.md": "Alpha fact",
			},
		});

		await expect(
			runPack({
				app: app as never,
				pack: groundedResearchDefault,
				query: "What happened?",
				onEvent: async (event) => {
					events.push(event as unknown as Record<string, unknown>);
				},
			}),
		).rejects.toMatchObject({
			name: "PackRunError",
			message: "Verifier offline",
			failure: {
				failedStepId: "verifier",
				transparency: {
					retriever: expect.objectContaining({
						status: "ready",
						elapsedMs: 200,
						notesFoundCount: 1,
					}),
					synthesizer: expect.objectContaining({
						status: "ready",
						elapsedMs: 300,
						claimCount: 1,
					}),
					verifier: expect.objectContaining({
						status: "absent",
						elapsedMs: 100,
					}),
					run: expect.objectContaining({
						state: "failed",
						elapsedMs: 900,
						stepElapsedMs: {
							retriever: 200,
							synthesizer: 300,
							verifier: 100,
						},
						failedStepId: "verifier",
					}),
				},
			},
		});
		await expect(
			runPack({
				app: app as never,
				pack: groundedResearchDefault,
				query: "What happened?",
			}),
		).rejects.toBeInstanceOf(PackRunError);

		expect(events).toContainEqual(
			expect.objectContaining({
				kind: "step",
				step: expect.objectContaining({
					id: "verifier",
					state: "failed",
					message: "Verifier offline",
				}),
				agentWork: expect.objectContaining({
					verifier: expect.objectContaining({
						status: "absent",
						elapsedMs: 100,
					}),
					run: expect.objectContaining({
						state: "failed",
						elapsedMs: 900,
					}),
				}),
			}),
		);
	});
});
