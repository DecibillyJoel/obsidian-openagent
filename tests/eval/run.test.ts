import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runEvalHarness } from "../../hackathon/eval/run";
import type { ChatMessage, ModelProvider, StreamEvent } from "../../src/types";

const fixturesDir = fileURLToPath(new URL("../../hackathon/eval/fixtures", import.meta.url));
const tempDirs: string[] = [];

describe("runEvalHarness", () => {
	afterEach(async () => {
		await Promise.all(
			tempDirs.splice(0).map(async (dir) => {
				await rm(dir, { recursive: true, force: true });
			}),
		);
	});

	it("writes timestamped JSON and markdown reports with baseline-vs-verified metrics", async () => {
		const resultsDir = await mkdtemp(path.join(tmpdir(), "open-agent-eval-"));
		tempDirs.push(resultsDir);

		const run = await runEvalHarness({ fixturesDir, resultsDir });
		const outputFiles = await readdir(resultsDir);
		const json = JSON.parse(await readFile(run.jsonPath, "utf8")) as {
			packId: string;
			perQuery: unknown[];
			baselineHallucinationRate: number;
			verifiedHallucinationRate: number;
			hallucinationRateDelta: number;
			totalClaims: number;
			totalFlaggedClaims: number;
			claimBuckets: { verified: number; unsupported: number; quoteMissing: number };
			fixture: { queryCount: number };
		};
		const markdown = await readFile(run.markdownPath, "utf8");

		expect(run.report.packId).toBe("grounded-research");
		expect(run.report.fixture.queryCount).toBe(20);
		expect(run.report.perQuery).toHaveLength(20);
		expect(run.report.totalClaims).toBeGreaterThan(0);
		expect(run.report.totalFlaggedClaims).toBeGreaterThan(0);
		expect(run.report.claimBuckets.verified).toBeGreaterThan(0);
		expect(run.report.claimBuckets.unsupported).toBeGreaterThan(0);
		expect(run.report.claimBuckets.quoteMissing).toBeGreaterThan(0);
		expect(run.report.baselineHallucinationRate).toBeGreaterThanOrEqual(run.report.verifiedHallucinationRate);
		expect(json.packId).toBe("grounded-research");
		expect(json.fixture.queryCount).toBe(20);
		expect(json.perQuery).toHaveLength(20);
		expect(json.hallucinationRateDelta).toBe(
			Number((json.baselineHallucinationRate - json.verifiedHallucinationRate).toFixed(4)),
		);
		expect(outputFiles.filter((file) => file.endsWith(".json"))).toHaveLength(1);
		expect(outputFiles.filter((file) => file.endsWith(".md"))).toHaveLength(1);
		expect(markdown).toContain("# Eval report");
		expect(markdown).toContain("## Per-query breakdown");
	});

	it("runs the live benchmark mode against a real markdown vault with injected providers", async () => {
		const workspaceDir = await mkdtemp(path.join(tmpdir(), "open-agent-live-eval-"));
		tempDirs.push(workspaceDir);

		const vaultDir = path.join(workspaceDir, "vault");
		const resultsDir = path.join(workspaceDir, "results");
		const benchmarkPath = path.join(workspaceDir, "benchmark.json");
		await mkdir(path.join(vaultDir, "laureates"), { recursive: true });
		await mkdir(resultsDir, { recursive: true });

		await writeFile(
			path.join(vaultDir, "laureates", "albert-einstein.md"),
			[
				"---",
				'title: "Albert Einstein"',
				"---",
				"",
				"# Albert Einstein",
				"",
				'Albert Einstein received the 1921 Nobel Prize in Physics for "his services to theoretical physics, and especially for his discovery of the law of the photoelectric effect".',
				"",
			].join("\n"),
			"utf8",
		);
		await writeFile(
			benchmarkPath,
			`${JSON.stringify(
				{
					packId: "grounded-research",
					datasetId: "mini-nobel",
					datasetName: "Mini Nobel benchmark",
					queries: [
						{
							id: "einstein-photoelectric",
							category: "single-fact",
							query: "What specific discovery did Albert Einstein's 1921 Nobel Prize in Physics especially recognize?",
							notesExpected: ["laureates/albert-einstein.md"],
							expectedCitations: ["laureates/albert-einstein.md"],
							expectedOutcome: "supported",
							expectedClaims: [
								{
									source_note: "laureates/albert-einstein.md",
									source_quote:
										'Albert Einstein received the 1921 Nobel Prize in Physics for "his services to theoretical physics, and especially for his discovery of the law of the photoelectric effect".',
									required_phrases: ["Einstein", "1921", "photoelectric effect"],
								},
							],
						},
					],
				},
				null,
				2,
			)}\n`,
			"utf8",
		);

		const providerFactory = (_config: unknown, agentId: string): ModelProvider => ({
			async *stream(messages: ChatMessage[]): AsyncIterable<StreamEvent> {
				if (agentId === "retriever") {
					yield {
						kind: "text",
						text:
							'- laureates/albert-einstein.md: Albert Einstein received the 1921 Nobel Prize in Physics for "his services to theoretical physics, and especially for his discovery of the law of the photoelectric effect".',
					};
					yield { kind: "done", finishReason: "stop" };
					return;
				}
				if (agentId === "synthesizer") {
					yield {
						kind: "text",
						text: JSON.stringify({
							summary: "Einstein's Nobel citation especially recognized the photoelectric effect.",
							claims: [
								{
									id: "c1",
									text: "Albert Einstein's 1921 Nobel Prize in Physics especially recognized the photoelectric effect.",
									source_note: "laureates/albert-einstein.md",
									source_quote:
										'Albert Einstein received the 1921 Nobel Prize in Physics for "his services to theoretical physics, and especially for his discovery of the law of the photoelectric effect".',
									confidence: 0.98,
								},
							],
						}),
					};
					yield { kind: "done", finishReason: "stop" };
					return;
				}

				const content = messages.at(-1)?.content ?? "";
				const prompt = typeof content === "string" ? content : "";
				yield {
					kind: "text",
					text: JSON.stringify({
						decisions: [
							{
								claim_id: prompt.includes('"claim_id": "c1"') ? "c1" : "unknown",
								supports_claim: prompt.includes("photoelectric effect"),
								explanation: "The cited quote directly supports the benchmark claim.",
							},
						],
					}),
				};
				yield { kind: "done", finishReason: "stop" };
			},
		});

		const run = await runEvalHarness({
			live: true,
			benchmarkPath,
			vaultDir,
			resultsDir,
			providerFactory,
		});

		const outputFiles = await readdir(resultsDir);
		const markdown = await readFile(run.markdownPath, "utf8");

		expect(run.report.mode).toBe("live");
		expect(run.report.dataset?.id).toBe("mini-nobel");
		expect(run.report.fixture.queryCount).toBe(1);
		expect(run.report.baselineHallucinationRate).toBe(0);
		expect(run.report.verifiedHallucinationRate).toBe(0);
		expect(run.report.perQuery).toHaveLength(1);
		expect(outputFiles.filter((file) => file.endsWith(".json"))).toHaveLength(1);
		expect(outputFiles.filter((file) => file.endsWith(".md"))).toHaveLength(1);
		expect(markdown).toContain("- **Mode:** live");
		expect(markdown).toContain("- **Dataset:** Mini Nobel benchmark");
	});

	it("batches live benchmark execution by stage across queries", async () => {
		const workspaceDir = await mkdtemp(path.join(tmpdir(), "open-agent-live-eval-batched-"));
		tempDirs.push(workspaceDir);

		const vaultDir = path.join(workspaceDir, "vault");
		const resultsDir = path.join(workspaceDir, "results");
		const benchmarkPath = path.join(workspaceDir, "benchmark.json");
		await mkdir(path.join(vaultDir, "laureates"), { recursive: true });
		await mkdir(resultsDir, { recursive: true });

		await writeFile(
			path.join(vaultDir, "laureates", "albert-einstein.md"),
			'Albert Einstein received the 1921 Nobel Prize in Physics for "his services to theoretical physics, and especially for his discovery of the law of the photoelectric effect".\n',
			"utf8",
		);
		await writeFile(
			path.join(vaultDir, "laureates", "max-planck.md"),
			'He won the 1918 Nobel Prize in Physics "for the services he rendered to the advancement of physics by his discovery of energy quanta."\n',
			"utf8",
		);
		await writeFile(
			benchmarkPath,
			`${JSON.stringify(
				{
					packId: "grounded-research",
					datasetId: "mini-nobel-batched",
					datasetName: "Mini Nobel batched benchmark",
					queries: [
						{
							id: "einstein-photoelectric",
							category: "single-fact",
							query: "What discovery was Einstein's 1921 Physics Nobel for?",
							notesExpected: ["laureates/albert-einstein.md"],
							expectedCitations: ["laureates/albert-einstein.md"],
							expectedOutcome: "supported",
							expectedClaims: [
								{
									source_note: "laureates/albert-einstein.md",
									source_quote:
										'Albert Einstein received the 1921 Nobel Prize in Physics for "his services to theoretical physics, and especially for his discovery of the law of the photoelectric effect".',
									required_phrases: ["Einstein", "1921", "photoelectric effect"],
								},
							],
						},
						{
							id: "planck-energy-quanta",
							category: "single-fact",
							query: "What did Max Planck win the 1918 Nobel Prize in Physics for?",
							notesExpected: ["laureates/max-planck.md"],
							expectedCitations: ["laureates/max-planck.md"],
							expectedOutcome: "supported",
							expectedClaims: [
								{
									source_note: "laureates/max-planck.md",
									source_quote:
										'He won the 1918 Nobel Prize in Physics "for the services he rendered to the advancement of physics by his discovery of energy quanta."',
									required_phrases: ["Planck", "1918", "energy quanta"],
								},
							],
						},
					],
				},
				null,
				2,
			)}\n`,
			"utf8",
		);

		const stageOrder: string[] = [];
		const providerFactory = (_config: unknown, agentId: string): ModelProvider => ({
			async *stream(messages: ChatMessage[]): AsyncIterable<StreamEvent> {
				stageOrder.push(agentId);
				const content = messages.at(-1)?.content ?? "";
				const prompt = typeof content === "string" ? content : "";
				if (agentId === "retriever") {
					yield {
						kind: "text",
						text: prompt.includes("Einstein")
							? '- laureates/albert-einstein.md: Albert Einstein received the 1921 Nobel Prize in Physics for "his services to theoretical physics, and especially for his discovery of the law of the photoelectric effect".'
							: '- laureates/max-planck.md: He won the 1918 Nobel Prize in Physics "for the services he rendered to the advancement of physics by his discovery of energy quanta."',
					};
					yield { kind: "done", finishReason: "stop" };
					return;
				}
				if (agentId === "synthesizer") {
					yield {
						kind: "text",
						text: prompt.includes("Einstein")
							? JSON.stringify({
									summary: "Einstein won for the photoelectric effect.",
									claims: [
										{
											id: "c1",
											text: "Albert Einstein's 1921 Nobel Prize in Physics recognized the photoelectric effect.",
											source_note: "laureates/albert-einstein.md",
											source_quote:
												'Albert Einstein received the 1921 Nobel Prize in Physics for "his services to theoretical physics, and especially for his discovery of the law of the photoelectric effect".',
											confidence: 0.98,
										},
									],
								})
							: JSON.stringify({
									summary: "Planck won for energy quanta.",
									claims: [
										{
											id: "c2",
											text: "Max Planck won the 1918 Nobel Prize in Physics for discovering energy quanta.",
											source_note: "laureates/max-planck.md",
											source_quote:
												'He won the 1918 Nobel Prize in Physics "for the services he rendered to the advancement of physics by his discovery of energy quanta."',
											confidence: 0.97,
										},
									],
								}),
					};
					yield { kind: "done", finishReason: "stop" };
					return;
				}

				yield {
					kind: "text",
					text: JSON.stringify({
						decisions: [
							{
								claim_id: prompt.includes('"claim_id": "c1"') ? "c1" : "c2",
								supports_claim: true,
								explanation: "The quote supports the claim.",
							},
						],
					}),
				};
				yield { kind: "done", finishReason: "stop" };
			},
		});

		const run = await runEvalHarness({
			live: true,
			benchmarkPath,
			vaultDir,
			resultsDir,
			providerFactory,
		});

		expect(run.report.perQuery).toHaveLength(2);
		expect(stageOrder).toEqual([
			"retriever",
			"retriever",
			"synthesizer",
			"synthesizer",
			"verifier",
			"verifier",
		]);
	});

	it("classifies a live claim as verified when required_phrases match even if quote wording differs", async () => {
		const workspaceDir = await mkdtemp(path.join(tmpdir(), "open-agent-phrase-match-"));
		tempDirs.push(workspaceDir);
		const vaultDir = path.join(workspaceDir, "vault");
		const resultsDir = path.join(workspaceDir, "results");
		const benchmarkPath = path.join(workspaceDir, "benchmark.json");
		await mkdir(path.join(vaultDir, "laureates"), { recursive: true });
		await mkdir(resultsDir, { recursive: true });

		const noteBody = 'Einstein received the 1921 Nobel Prize in Physics for "the discovery of the law of the photoelectric effect".';
		await writeFile(path.join(vaultDir, "laureates", "einstein.md"), noteBody, "utf8");

		const benchmark = {
			packId: "grounded-research",
			datasetId: "phrase-match-test",
			datasetName: "Phrase Match Test",
			queries: [
				{
					id: "q1",
					category: "single-fact",
					query: "Why did Einstein win the Nobel Prize?",
					notesExpected: ["laureates/einstein.md"],
					expectedCitations: ["laureates/einstein.md"],
					expectedOutcome: "supported",
					expectedClaims: [
						{
							source_note: "laureates/einstein.md",
							source_quote: "discovery of the photoelectric effect law",
							required_phrases: ["1921", "photoelectric effect"],
						},
					],
				},
			],
		};
		await writeFile(benchmarkPath, JSON.stringify(benchmark), "utf8");

		// Model produces a claim with matching required_phrases but different quote wording
		const modelQuote = "the discovery of the law of the photoelectric effect";
		const providerFactory = (_config: unknown, agentId: string): ModelProvider => ({
			async *stream(messages: ChatMessage[]): AsyncIterable<StreamEvent> {
				if (agentId === "retriever") {
					yield { kind: "text", text: `- laureates/einstein.md: ${noteBody}` };
					yield { kind: "done", finishReason: "stop" };
					return;
				}
				if (agentId === "synthesizer") {
					yield {
						kind: "text",
						text: JSON.stringify({
							summary: "Einstein won for photoelectric effect",
							claims: [{
								id: "c1",
								text: "Einstein won the 1921 Nobel Prize for his discovery of the photoelectric effect",
								source_note: "laureates/einstein.md",
								source_quote: modelQuote,
								confidence: 1,
							}],
						}),
					};
					yield { kind: "done", finishReason: "stop" };
					return;
				}
				// verifier
				const content = messages.at(-1)?.content ?? "";
				const prompt = typeof content === "string" ? content : "";
				yield {
					kind: "text",
					text: JSON.stringify({
						decisions: [{
							claim_id: prompt.includes('"claim_id": "c1"') ? "c1" : "unknown",
							supports_claim: true,
							explanation: "The note supports the claim.",
						}],
					}),
				};
				yield { kind: "done", finishReason: "stop" };
			},
		});

		const run = await runEvalHarness({
			live: true,
			benchmarkPath,
			vaultDir,
			resultsDir,
			providerFactory,
		});

		// With phrase-only matching, the claim should be verified (0% hallucination)
		expect(run.report.baselineHallucinationRate).toBe(0);
		expect(run.report.verifiedHallucinationRate).toBe(0);
	});

	it("treats unsupported live queries as passing when verifier flags all synthesized claims", async () => {
		const workspaceDir = await mkdtemp(path.join(tmpdir(), "open-agent-live-eval-unsupported-"));
		tempDirs.push(workspaceDir);

		const vaultDir = path.join(workspaceDir, "vault");
		const resultsDir = path.join(workspaceDir, "results");
		const benchmarkPath = path.join(workspaceDir, "benchmark.json");
		await mkdir(resultsDir, { recursive: true });
		await mkdir(vaultDir, { recursive: true });

		await writeFile(
			benchmarkPath,
			`${JSON.stringify(
				{
					_schema_notes: {
						outcomes: {
							unsupported:
								"Pass when the synthesizer refuses or when verifier flags every fabricated claim.",
						},
					},
					packId: "grounded-research",
					datasetId: "mini-nobel-unsupported",
					datasetName: "Mini Nobel unsupported benchmark",
					queries: [
						{
							id: "hawking-trap",
							category: "negative-fact",
							query: "When did Stephen Hawking win the Nobel Prize in Physics?",
							trapNote: "Hawking never won a Physics Nobel in this corpus.",
							notesExpected: [],
							expectedCitations: [],
							expectedOutcome: "unsupported",
							expectedClaims: [],
						},
					],
				},
				null,
				2,
			)}\n`,
			"utf8",
		);

		const providerFactory = (_config: unknown, agentId: string): ModelProvider => ({
			async *stream(): AsyncIterable<StreamEvent> {
				if (agentId === "retriever") {
					yield { kind: "text", text: "No supporting Nobel Physics laureate notes were retrieved." };
					yield { kind: "done", finishReason: "stop" };
					return;
				}
				if (agentId === "synthesizer") {
					yield {
						kind: "text",
						text: JSON.stringify({
							summary: "Stephen Hawking won the Nobel Prize in Physics in 1988.",
							claims: [
								{
									id: "c1",
									text: "Stephen Hawking won the Nobel Prize in Physics in 1988.",
									source_note: "laureates/stephen-hawking.md",
									source_quote: "Stephen Hawking won the Nobel Prize in Physics in 1988.",
									confidence: 0.22,
								},
							],
						}),
					};
					yield { kind: "done", finishReason: "stop" };
					return;
				}

				yield {
					kind: "text",
					text: JSON.stringify({
						decisions: [
							{
								claim_id: "c1",
								supports_claim: false,
								explanation: "The claim should be rejected.",
							},
						],
					}),
				};
				yield { kind: "done", finishReason: "stop" };
			},
		});

		const run = await runEvalHarness({
			live: true,
			benchmarkPath,
			vaultDir,
			resultsDir,
			providerFactory,
		});

		expect(run.report.mode).toBe("live");
		expect(run.report.dataset?.id).toBe("mini-nobel-unsupported");
		expect(run.report.fixture.categories["negative-fact"]).toBe(1);
		expect(run.report.baselineHallucinationRate).toBe(1);
		expect(run.report.verifiedHallucinationRate).toBe(0);
		expect(run.report.totalClaims).toBe(1);
		expect(run.report.totalFlaggedClaims).toBe(1);
		expect(run.report.claimBuckets.quoteMissing).toBe(1);
		expect(run.report.perQuery[0]?.expectedOutcome).toBe("unsupported");
		expect(run.report.perQuery[0]?.verifiedFlaggedClaims).toBe(1);
		expect(run.report.perQuery[0]?.verifiedSurfacedClaimCount).toBe(0);
	});
});
