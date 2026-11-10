import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import groundedResearchDefault from "../src/packs/defaults/grounded-research.json";
import { DEFAULT_SETTINGS } from "../src/settings";
import type { StoredPackTurnData } from "../src/sessions";
import { AuthError, NetworkError, type FinishReason } from "../src/types";
import { ChatView } from "../src/view";
import {
	MockElement,
	MockTFile,
	NoticeMock,
	createMockApp,
	fetchMock,
	requestUrlMock,
	setMobileMode,
} from "./setup";

function createDeps(activeSession: {
	id: string;
	model: string;
	selectedPackId: string | null;
	lastClassicModel: string;
	textModel?: string | null;
	imageModel?: string | null;
	turns?: unknown[];
	recovery?: {
		reason: "turns-corrupt";
		message: string;
		backupPath: string;
		recoveredAt: number;
	} | null;
}): {
	deps: ConstructorParameters<typeof ChatView>[1];
	updateSelectedPack: ReturnType<typeof vi.fn>;
} {
	const updateSelectedPack = vi.fn(async () => undefined);
	const deps = {
		getSettings: () => ({ ...DEFAULT_SETTINGS, apiKey: "token" }),
		openSettings: vi.fn(),
		tools: {} as never,
		consent: {} as never,
		undo: {} as never,
		sessionStore: {
			getActive: () => ({
				title: "Session",
				createdAt: 1,
				updatedAt: 1,
				turns: [],
				...activeSession,
			}),
			getSessions: () => [],
			updateSelectedPack,
		} as never,
		getPacks: vi.fn(),
		runPack: vi.fn(),
	};
	return { deps, updateSelectedPack };
}

function findByClass(root: MockElement, className: string): MockElement[] {
	const results: MockElement[] = [];
	if (root.classList.contains(className)) results.push(root);
	for (const child of root.children) results.push(...findByClass(child, className));
	return results;
}

function textTree(root: MockElement): string {
	return [root.textContent, ...root.children.map((child) => textTree(child))]
		.filter(Boolean)
		.join(" ");
}

function optionValuesOf(select: MockElement): string[] {
	const out: string[] = [];
	for (const child of select.children) {
		if (child.tagName === "optgroup") out.push(...child.children.map((option) => option.value));
		else out.push(child.value);
	}
	return out;
}

function groupLabelsOf(select: MockElement): string[] {
	return select.children.filter((child) => child.tagName === "optgroup").map((group) => group.attrs.label ?? "");
}

function renderPackTurn(view: ChatView, packTurn: StoredPackTurnData): MockElement {
	const parent = new MockElement("div");
	(
		view as unknown as {
			renderPackTurn(target: HTMLElement, packTurn: StoredPackTurnData): void;
		}
	).renderPackTurn(parent as unknown as HTMLElement, packTurn);
	return parent;
}

function createAgentWorkTurn(overrides: Partial<StoredPackTurnData> = {}): StoredPackTurnData {
	return {
		packId: groundedResearchDefault.id,
		packName: groundedResearchDefault.name,
		progressSteps: [
			{ id: "retriever", label: "Retriever", state: "complete" },
			{ id: "synthesizer", label: "Synthesizer", state: "complete" },
			{ id: "verifier", label: "Verifier", state: "complete" },
		],
		verifiedSummary: "- Alpha evidence",
		researchMarkdown:
			"Alpha is supported by the source note. [1](openagent://citation/1)\n\nBeta needs more support before it can be verified. [2](openagent://citation/2)",
		citations: [
			{
				claimId: "claim-verified",
				notePath: "notes/source.md",
				exactPhrase: "Alpha evidence",
				startOffset: 0,
				endOffset: "Alpha evidence".length,
				occurrenceIndex: 0,
			},
			{
				claimId: "claim-missing",
				notePath: "notes/source.md",
				exactPhrase: "Beta quote",
				startOffset: 14,
				endOffset: 24,
				occurrenceIndex: 0,
			},
		],
		claims: [
			{
				id: "claim-verified",
				text: "Alpha is supported",
				sourceNote: "notes/source.md",
				sourceQuote: "Alpha evidence",
				quotePresent: true,
				supportsClaim: true,
				supportExplanation: "Directly supported",
				status: "verified",
				exactPhraseAnchor: {
					notePath: "notes/source.md",
					exactPhrase: "Alpha evidence",
					startOffset: 0,
					endOffset: "Alpha evidence".length,
					occurrenceIndex: 0,
				},
			},
			{
				id: "claim-missing",
				text: "Beta needs more support",
				sourceNote: "notes/source.md",
				sourceQuote: "Beta quote",
				quotePresent: false,
				supportsClaim: null,
				supportExplanation: "Quoted text not found in the live note.",
				status: "quote-missing",
			},
		],
		agentWork: {
			retriever: {
				status: "ready",
				elapsedMs: 2400,
				notesFoundCount: 5,
				topNotePaths: [
					"notes/source.md",
					"notes/appendix.md",
					"notes/archive.md",
				],
				brief: "- notes/source.md backs Alpha\n- notes/appendix.md adds context",
			},
			synthesizer: {
				status: "ready",
				elapsedMs: 11200,
				claimCount: 2,
				summary: "Alpha is directly supported by the source note. Beta needs more evidence before it can be treated as verified.",
				rawJson: {
					summary: "Alpha is directly supported by the source note. Beta needs more evidence before it can be treated as verified.",
					claims: [
						{
							id: "claim-verified",
							text: "Alpha is supported",
							source_note: "notes/source.md",
							source_quote: "Alpha evidence",
							confidence: 0.91,
						},
						{
							id: "claim-missing",
							text: "Beta needs more support",
							source_note: "notes/source.md",
							source_quote: "Beta quote",
							confidence: 0.42,
						},
					],
				},
			},
			verifier: {
				status: "ready",
				elapsedMs: 62000,
				counts: {
					verified: 1,
					unsupported: 0,
					quoteMissing: 1,
				},
				reasons: [
					{
						claimId: "claim-verified",
						claimText: "Alpha is supported by the source note and should remain first in order.",
						sourceNote: "notes/source.md",
						status: "verified",
						explanation: "Direct quote support found.",
					},
					{
						claimId: "claim-missing",
						claimText: "Beta needs more support before it can be considered safe to state confidently.",
						sourceNote: "notes/source.md",
						status: "quote-missing",
						explanation: "Quote was not found in the live note.",
					},
				],
			},
			run: {
				state: "completed",
				elapsedMs: 75600,
				stepElapsedMs: {
					retriever: 2400,
					synthesizer: 11200,
					verifier: 62000,
				},
			},
		},
		modelsUsed: {
			retriever: "gemma-4-4b-it",
			synthesizer: "gemma-4-31b-it",
			verifier: "gemma-4-4b-it",
		},
		...overrides,
	};
}

const agentWorkStyles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

describe("ChatView pack UI", () => {
	it("stores pack selection per session and preserves the classic model for future turns", async () => {
		const app = createMockApp();
		const { deps, updateSelectedPack } = createDeps({
			id: "session-a",
			model: "gpt-4o-mini",
			selectedPackId: null,
			lastClassicModel: "gpt-4o-mini",
		});
		const view = new ChatView({ app } as never, deps);
		(view as unknown as { modeSelectEl: { value: string }; modelInputEl: { value: string } }).modeSelectEl = {
			value: groundedResearchDefault.id,
		};
		(view as unknown as { modeSelectEl: { value: string }; modelInputEl: { value: string } }).modelInputEl = {
			value: "restored-classic-model",
		};
		vi.spyOn(view as never, "refreshHeader" as never).mockImplementation(() => undefined);
		vi.spyOn(view as never, "refreshConfiguredState" as never).mockImplementation(() => undefined);

		await (view as unknown as { handleModeChange(): Promise<void> }).handleModeChange();

		expect(updateSelectedPack).toHaveBeenCalledWith(
			"session-a",
			groundedResearchDefault.id,
			"restored-classic-model",
		);
	});

	it("hides unsupported packs on mobile and blocks desktop-only packs from running", () => {
		setMobileMode(true);
		const app = createMockApp();
		const { deps } = createDeps({
			id: "session-a",
			model: "gpt-4o-mini",
			selectedPackId: groundedResearchDefault.id,
			lastClassicModel: "gpt-4o-mini",
		});
		const view = new ChatView({ app } as never, deps);
		(view as unknown as { availablePacks: typeof groundedResearchDefault[] }).availablePacks = [
			groundedResearchDefault,
			{
				...structuredClone(groundedResearchDefault),
				id: "mobile-pack",
				name: "Mobile Pack",
				support: { mobile: true },
			},
		];

		expect((view as unknown as { getSelectablePacks(): Array<{ id: string }> }).getSelectablePacks().map((pack) => pack.id)).toEqual([
			"mobile-pack",
		]);
		expect((view as unknown as { isMobileBlockedPack(): boolean }).isMobileBlockedPack()).toBe(true);

		setMobileMode(false);
	});

	it("renders claim cards as secondary evidence with Show evidence / Hide evidence copy, source-note navigation, and model attribution", () => {
		const app = createMockApp({
			files: {
				"notes/source.md": "Alpha evidence",
			},
		});
		const openFile = vi.fn(async () => undefined);
		app.workspace.getLeaf = vi.fn(() => ({ openFile }));
		const { deps } = createDeps({
			id: "session-a",
			model: "gpt-4o-mini",
			selectedPackId: groundedResearchDefault.id,
			lastClassicModel: "gpt-4o-mini",
		});
		const view = new ChatView({ app } as never, deps);
		const parent = new MockElement("div");

		(
			view as unknown as {
				renderPackTurn(target: HTMLElement, packTurn: {
					progressSteps: Array<{ id: string; label: string; state: "pending" | "running" | "complete" | "failed"; message?: string }>;
					verifiedSummary?: string;
					claims?: Array<{
						id: string;
						text: string;
						sourceNote: string;
						sourceQuote: string;
						quotePresent: boolean;
						supportsClaim: boolean | null;
						supportExplanation: string;
						status: "verified" | "unsupported" | "quote-missing";
					}>;
					modelsUsed?: { retriever: string; synthesizer: string; verifier: string };
				}): void;
			}
		).renderPackTurn(parent as unknown as HTMLElement, {
			progressSteps: [
				{ id: "retriever", label: "Retrieving notes", state: "complete" },
				{ id: "synthesizer", label: "Drafting claims", state: "complete" },
				{ id: "verifier", label: "Verifying claims", state: "complete" },
			],
			verifiedSummary: "- Alpha evidence",
			claims: [
				{
					id: "claim-verified",
					text: "Alpha is supported",
					sourceNote: "notes/source.md",
					sourceQuote: "Alpha evidence",
					quotePresent: true,
					supportsClaim: true,
					supportExplanation: "Directly supported",
					status: "verified",
				},
				{
					id: "claim-flagged",
					text: "Beta is unsupported",
					sourceNote: "notes/source.md",
					sourceQuote: "Beta quote",
					quotePresent: false,
					supportsClaim: null,
					supportExplanation: "Quoted text not found in the live note.",
					status: "quote-missing",
				},
			],
			modelsUsed: {
				retriever: "gemma-4-4b-it",
				synthesizer: "gemma-4-31b-it",
				verifier: "gemma-4-4b-it",
			},
		});

		const cards = findByClass(parent, "open-agent-claim");
		expect(cards).toHaveLength(2);
		const verifiedDetails = findByClass(cards[0], "open-agent-claim-details")[0];
		const flaggedDetails = findByClass(cards[1], "open-agent-claim-details")[0];
		const toggles = findByClass(parent, "open-agent-claim-toggle");

		expect(toggles[0].textContent).toBe("Show evidence");
		expect(verifiedDetails.classList.contains("is-hidden")).toBe(true);
		expect(toggles[1].textContent).toBe("Hide evidence");
		expect(flaggedDetails.classList.contains("is-hidden")).toBe(false);

		toggles[0].click();
		expect(toggles[0].textContent).toBe("Hide evidence");
		expect(verifiedDetails.classList.contains("is-hidden")).toBe(false);
		expect(textTree(verifiedDetails)).toContain("Directly supported");

		findByClass(cards[0], "open-agent-claim-open")[0].click();
		expect(openFile).toHaveBeenCalledWith(expect.objectContaining({ path: "notes/source.md" }));
		expect(openFile.mock.calls[0]?.[0]).toBeInstanceOf(MockTFile);

		expect(findByClass(parent, "open-agent-pack-model-footer")[0]?.textContent).toBe(
			"Models used: Retriever — gemma-4-4b-it; Synthesizer — gemma-4-31b-it; Verifier — gemma-4-4b-it",
		);
	});

	it("renders Research result first, then the step stack, then claim cards, then the model footer", () => {
		const app = createMockApp();
		const { deps } = createDeps({
			id: "session-a",
			model: "gpt-4o-mini",
			selectedPackId: groundedResearchDefault.id,
			lastClassicModel: "gpt-4o-mini",
		});
		const view = new ChatView({ app } as never, deps);
		const parent = renderPackTurn(view, createAgentWorkTurn());

		expect(parent.children[0]?.classList.contains("open-agent-pack-result")).toBe(true);
		expect(textTree(parent.children[0] as HTMLElement)).toContain("Research result");
		expect(textTree(parent.children[0] as HTMLElement)).toContain("1m 16s");
		expect(findByClass(parent.children[0] as HTMLElement, "open-agent-pack-result-body")).toHaveLength(1);
		expect(parent.children[1]?.textContent).toBe("How this answer was built");
		expect(parent.children[2]?.classList.contains("open-agent-pack-progress")).toBe(true);
		expect(parent.children.at(-1)?.classList.contains("open-agent-pack-model-footer")).toBe(true);
	});

	it("does not render Agent work, Run details, or a standalone run metadata node", () => {
		const app = createMockApp();
		const { deps } = createDeps({
			id: "session-a",
			model: "gpt-4o-mini",
			selectedPackId: groundedResearchDefault.id,
			lastClassicModel: "gpt-4o-mini",
		});
		const view = new ChatView({ app } as never, deps);
		const parent = renderPackTurn(view, createAgentWorkTurn());

		expect(textTree(parent)).not.toContain("Agent work");
		expect(textTree(parent)).not.toContain("Run details");
		expect(textTree(parent)).not.toContain("Run metadata");
		expect(findByClass(parent, "open-agent-pack-info-bar")).toHaveLength(0);
		expect(findByClass(parent, "open-agent-pack-info-panel")).toHaveLength(0);
	});

	it("uses whole-row step disclosures with one expanded row at a time", () => {
		const app = createMockApp();
		const { deps } = createDeps({
			id: "session-a",
			model: "gpt-4o-mini",
			selectedPackId: groundedResearchDefault.id,
			lastClassicModel: "gpt-4o-mini",
		});
		const view = new ChatView({ app } as never, deps);
		const parent = renderPackTurn(view, createAgentWorkTurn());
		const steps = findByClass(parent, "open-agent-pack-step");

		expect(steps).toHaveLength(3);
		expect(steps[0]?.tagName).toBe("div");
		expect(steps[1]?.tagName).toBe("div");
		expect(steps[2]?.tagName).toBe("div");
		expect(findByClass(steps[0], "open-agent-pack-step-state")[0]?.textContent).toBe("Complete");
		expect(findByClass(steps[0], "open-agent-pack-step-disclosure")[0]?.textContent).toBe("▸");
		expect(findByClass(parent, "open-agent-pack-step-details").filter((el) => !el.classList.contains("is-hidden"))).toHaveLength(0);

		steps[0].click();
		expect(findByClass(steps[0], "open-agent-pack-step-disclosure")[0]?.textContent).toBe("▾");
		expect(findByClass(parent, "open-agent-pack-step-details").filter((el) => !el.classList.contains("is-hidden"))).toHaveLength(1);
		expect(textTree(parent)).toContain("notes/source.md");

		steps[1].click();
		const openPanels = findByClass(parent, "open-agent-pack-step-details").filter((el) => !el.classList.contains("is-hidden"));
		expect(openPanels).toHaveLength(1);
		expect(textTree(openPanels[0])).toContain("Raw JSON");
	});

	it("auto-expands the failed step on first render", () => {
		const app = createMockApp();
		const { deps } = createDeps({
			id: "session-a",
			model: "gpt-4o-mini",
			selectedPackId: groundedResearchDefault.id,
			lastClassicModel: "gpt-4o-mini",
		});
		const view = new ChatView({ app } as never, deps);
		const parent = renderPackTurn(view, createAgentWorkTurn({
			progressSteps: [
				{ id: "retriever", label: "Retriever", state: "complete" },
				{ id: "synthesizer", label: "Synthesizer", state: "failed", message: "Synthesizer failed" },
				{ id: "verifier", label: "Verifier", state: "pending" },
			],
			agentWork: {
				retriever: {
					status: "ready",
					elapsedMs: 2400,
					notesFoundCount: 2,
					topNotePaths: ["notes/source.md", "notes/appendix.md"],
					brief: "- notes/source.md backs Alpha",
				},
				synthesizer: { status: "absent", elapsedMs: 2400 },
				verifier: { status: "pending" },
				run: {
					state: "failed",
					elapsedMs: 4800,
					stepElapsedMs: { retriever: 2400, synthesizer: 2400 },
					failedStepId: "synthesizer",
				},
			},
		}));

		const openPanels = findByClass(parent, "open-agent-pack-step-details").filter((el) => !el.classList.contains("is-hidden"));
		expect(openPanels).toHaveLength(1);
		expect(textTree(openPanels[0])).toContain("No details captured.");
		expect(textTree(parent)).toContain("Synthesizer failed");
	});

	it("keeps legacy and classic turns unchanged and reuses the existing note-opening path for retriever note chips", () => {
		const app = createMockApp({
			files: {
				"notes/source.md": "Alpha evidence",
			},
		});
		const openFile = vi.fn(async () => undefined);
		app.workspace.getLeaf = vi.fn(() => ({ openFile }));
		const { deps } = createDeps({
			id: "session-a",
			model: "gpt-4o-mini",
			selectedPackId: groundedResearchDefault.id,
			lastClassicModel: "gpt-4o-mini",
		});
		const view = new ChatView({ app } as never, deps);

		const withWork = renderPackTurn(view, createAgentWorkTurn());
		findByClass(withWork, "open-agent-pack-step")[0].click();
		findByClass(withWork, "open-agent-work-note-path")[0].click();
		expect(openFile).toHaveBeenCalledWith(expect.objectContaining({ path: "notes/source.md" }));
		expect(openFile.mock.calls[0]?.[0]).toBeInstanceOf(MockTFile);

		const legacyPackTurn = renderPackTurn(view, {
			packId: groundedResearchDefault.id,
			packName: groundedResearchDefault.name,
			progressSteps: [{ id: "retriever", label: "Retrieving notes", state: "complete" }],
			verifiedSummary: "- Legacy answer",
		});
		expect(textTree(legacyPackTurn)).toContain("Legacy answer");
		expect(textTree(legacyPackTurn)).not.toContain("Research result");

		const classicView = new ChatView({ app } as never, createDeps({
			id: "session-classic",
			model: "gpt-4o-mini",
			selectedPackId: null,
			lastClassicModel: "gpt-4o-mini",
		}).deps);
		const classicRow = new MockElement("div");
		(
			classicView as unknown as {
				renderTranscript(): void;
				transcriptEl: MockElement;
				turns: unknown[];
			}
		).transcriptEl = classicRow;
		(
			classicView as unknown as {
				transcriptEl: MockElement;
				turns: unknown[];
			}
		).turns = [{
			role: "assistant",
			content: "",
			segments: [{ kind: "text", text: "Classic answer" }],
			toolCallMap: {},
			thinking: false,
		}];
		(classicView as unknown as { renderTranscript(): void }).renderTranscript();
		expect(findByClass(classicRow, "open-agent-pack-step")).toHaveLength(0);
	});

	it("renders live pending states and failed-run missing data inside the step rows", () => {
		const app = createMockApp();
		const { deps } = createDeps({
			id: "session-a",
			model: "gpt-4o-mini",
			selectedPackId: groundedResearchDefault.id,
			lastClassicModel: "gpt-4o-mini",
		});
		const view = new ChatView({ app } as never, deps);

		const liveParent = renderPackTurn(view, createAgentWorkTurn({
			agentWork: {
				retriever: {
					status: "ready",
					elapsedMs: 2400,
					notesFoundCount: 2,
					topNotePaths: ["notes/source.md", "notes/appendix.md"],
					brief: "- notes/source.md backs Alpha",
				},
				synthesizer: { status: "pending" },
				verifier: { status: "pending" },
				run: {
					state: "running",
					elapsedMs: 2400,
					stepElapsedMs: { retriever: 2400 },
				},
			},
			claims: [],
			verifiedSummary: "",
		}));
		const liveSteps = findByClass(liveParent, "open-agent-pack-step");
		liveSteps[1].click();
		expect(textTree(liveParent)).toContain("Waiting for step to finish.");

		const failedParent = renderPackTurn(view, createAgentWorkTurn({
			agentWork: {
				retriever: {
					status: "ready",
					elapsedMs: 2400,
					notesFoundCount: 2,
					topNotePaths: ["notes/source.md", "notes/appendix.md"],
					brief: "- notes/source.md backs Alpha",
				},
				synthesizer: { status: "absent" },
				verifier: { status: "absent" },
				run: {
					state: "failed",
					elapsedMs: 9100,
					stepElapsedMs: { retriever: 2400 },
					failedStepId: "synthesizer",
				},
			},
			claims: [],
			verifiedSummary: "",
		}));
		const failedOpenPanels = findByClass(failedParent, "open-agent-pack-step-details").filter((el) => !el.classList.contains("is-hidden"));
		expect(failedOpenPanels).toHaveLength(1);
		expect(textTree(failedParent)).toContain("No details captured.");
	});

	it("shows an immediate stopping state in the live transcript and controls", () => {
		const app = createMockApp();
		const { deps } = createDeps({
			id: "session-a",
			model: "gpt-4o-mini",
			selectedPackId: groundedResearchDefault.id,
			lastClassicModel: "gpt-4o-mini",
		});
		const view = new ChatView({ app } as never, deps);
		(view as unknown as { stoppingSessions: Set<string> }).stoppingSessions.add("session-a");

		const parent = renderPackTurn(view, createAgentWorkTurn({
			progressSteps: [
				{ id: "retriever", label: "Retriever", state: "running" },
				{ id: "synthesizer", label: "Synthesizer", state: "pending" },
				{ id: "verifier", label: "Verifier", state: "pending" },
			],
			agentWork: {
				retriever: {
					status: "ready",
					elapsedMs: 2400,
					notesFoundCount: 2,
					topNotePaths: ["notes/source.md", "notes/appendix.md"],
					brief: "- notes/source.md backs Alpha",
				},
				synthesizer: { status: "pending" },
				verifier: { status: "pending" },
				run: {
					state: "running",
					elapsedMs: 2400,
					stepElapsedMs: { retriever: 2400 },
				},
			},
			claims: [],
			verifiedSummary: "",
		}));
		expect(textTree(parent)).toContain("Stopping research...");
		expect(textTree(parent)).toContain("Stopping");
		expect(findByClass(parent, "open-agent-pack-step")[0]?.classList.contains("is-stopping")).toBe(true);

		const stopBtn = new MockElement("button");
		const sendBtn = new MockElement("button");
		const inputEl = new MockElement("textarea");
		Object.assign(view as unknown as Record<string, unknown>, {
			stopBtn,
			sendBtn,
			inputEl,
		});
		(view as unknown as { inFlights: Map<string, AbortController> }).inFlights.set("session-a", new AbortController());
		(view as unknown as { refreshBusyState(): void }).refreshBusyState();
		expect(stopBtn.textContent).toBe("Stopping...");
		expect((stopBtn as unknown as { disabled?: boolean }).disabled).toBe(true);
	});

	it("renders a stopped run as stopped instead of failed or unavailable", () => {
		const app = createMockApp();
		const { deps } = createDeps({
			id: "session-a",
			model: "gpt-4o-mini",
			selectedPackId: groundedResearchDefault.id,
			lastClassicModel: "gpt-4o-mini",
		});
		const view = new ChatView({ app } as never, deps);
		const parent = renderPackTurn(view, createAgentWorkTurn({
			progressSteps: [
				{ id: "retriever", label: "Retriever", state: "complete" },
				{ id: "synthesizer", label: "Synthesizer", state: "failed", message: "Stopped by user." },
				{ id: "verifier", label: "Verifier", state: "pending" },
			],
			agentWork: {
				retriever: {
					status: "ready",
					elapsedMs: 2400,
					notesFoundCount: 2,
					topNotePaths: ["notes/source.md", "notes/appendix.md"],
					brief: "- notes/source.md backs Alpha",
				},
				synthesizer: { status: "absent" },
				verifier: { status: "pending" },
				run: {
					state: "stopped",
					elapsedMs: 2400,
					stepElapsedMs: { retriever: 2400, synthesizer: 2400 },
				},
			},
			researchMarkdown: undefined,
			citations: undefined,
			claims: [],
			verifiedSummary: "",
		}));
		expect(textTree(parent)).toContain("Research stopped");
		expect(textTree(parent)).toContain("Progress before stop");
		expect(textTree(parent)).toContain("Stopped");
		expect(textTree(parent)).toContain("Stopped by user.");
		expect(textTree(parent)).not.toContain("Research result unavailable");
	});

	it("renders live progress rows immediately even before agentWork snapshots arrive", () => {
		const app = createMockApp();
		const { deps } = createDeps({
			id: "session-a",
			model: "gpt-4o-mini",
			selectedPackId: groundedResearchDefault.id,
			lastClassicModel: "gpt-4o-mini",
		});
		const view = new ChatView({ app } as never, deps);
		const parent = renderPackTurn(view, {
			packId: groundedResearchDefault.id,
			packName: groundedResearchDefault.name,
			progressSteps: [
				{ id: "retriever", label: "Retrieving notes", state: "running" },
				{ id: "synthesizer", label: "Drafting claims", state: "pending" },
				{ id: "verifier", label: "Verifying claims", state: "pending" },
			],
			retryingStepId: null,
		});

		const steps = findByClass(parent, "open-agent-pack-step");
		expect(steps).toHaveLength(3);
		expect(textTree(parent)).toContain("Retriever");
		expect(textTree(parent)).toContain("Running");
		expect(textTree(parent)).toContain("Synthesizer");
		expect(textTree(parent)).toContain("Pending");
		expect(textTree(parent)).not.toContain("Research result");
	});

	it("locks retriever, synthesizer, and verifier detail contracts inside the step rows", () => {
		const app = createMockApp();
		const { deps } = createDeps({
			id: "session-a",
			model: "gpt-4o-mini",
			selectedPackId: groundedResearchDefault.id,
			lastClassicModel: "gpt-4o-mini",
		});
		const view = new ChatView({ app } as never, deps);
		const parent = renderPackTurn(view, createAgentWorkTurn());
		const steps = findByClass(parent, "open-agent-pack-step");
		steps[0].click();
		expect(textTree(steps[0])).toContain("5 notes");
		expect(findByClass(parent, "open-agent-work-note-path").map((el) => el.textContent)).toEqual([
			"notes/source.md",
			"notes/appendix.md",
			"notes/archive.md",
		]);
		expect(textTree(steps[0])).toContain("+2 more");
		expect(textTree(steps[0])).toContain("notes/source.md backs Alpha");
		expect(textTree(steps[0])).not.toContain("0.91");

		steps[1].click();
		expect(textTree(steps[1])).toContain("2 draft claims");
		expect(textTree(steps[1])).toContain("Alpha is directly supported by the source note.");
		expect(textTree(steps[1])).toContain("Raw JSON");

		steps[2].click();
		expect(textTree(steps[2])).toContain("Verified 1");
		expect(textTree(steps[2])).toContain("Unsupported 0");
		expect(textTree(steps[2])).toContain("Quote missing 1");
		expect(textTree(steps[2])).toContain("source.md");
		expect(textTree(steps[2])).toContain("Direct quote support found.");
	});

	it("shows total timing near the research result and locks per-step timing display rules and fallbacks", () => {
		const app = createMockApp();
		const { deps } = createDeps({
			id: "session-a",
			model: "gpt-4o-mini",
			selectedPackId: groundedResearchDefault.id,
			lastClassicModel: "gpt-4o-mini",
		});
		const view = new ChatView({ app } as never, deps);
		const parent = renderPackTurn(view, createAgentWorkTurn({
			agentWork: {
				retriever: {
					status: "ready",
					notesFoundCount: 4,
					topNotePaths: ["notes/source.md", "notes/appendix.md", "notes/archive.md"],
					brief: "- notes/source.md backs Alpha",
				},
				synthesizer: {
					status: "ready",
					elapsedMs: 9800,
					claimCount: 2,
					summary: "First line stays visible.\nSecond line stays visible.\nThird line should not appear in the collapsed preview and the preview should also stop before this sentence keeps going past the 140 character cutoff.",
					rawJson: {
						summary: "First line stays visible. Second line stays visible.",
						claims: [],
					},
				},
				verifier: {
					status: "ready",
					counts: {
						verified: 1,
						unsupported: 2,
						quoteMissing: 3,
					},
					reasons: [],
				},
				run: {
					state: "completed",
					elapsedMs: 1500,
					stepElapsedMs: {
						retriever: undefined,
						synthesizer: 9800,
						verifier: undefined,
					},
				},
			},
		}));
		expect(textTree(parent.children[0] as HTMLElement)).toContain("1.5s");
		const steps = findByClass(parent, "open-agent-pack-step");
		expect(textTree(steps[0])).not.toContain("Timing unavailable");
		expect(textTree(steps[1])).toContain("9.8s");
		expect(textTree(steps[2])).not.toContain("Timing unavailable");
		steps[1].click();
		expect(textTree(steps[1])).toContain("2 draft claims");
		expect(textTree(steps[1])).not.toContain("Third line should not appear");
	});

	it("renders inline citation links, resolves exact jumps, and falls back safely when notes drift", async () => {
		const app = createMockApp({
			files: {
				"notes/source.md": "Lead in\nAlpha evidence\nBeta quote",
			},
		});
		const openFile = vi.fn(async () => undefined);
		app.workspace.getLeaf = vi.fn(() => ({ openFile }));
		const { deps } = createDeps({
			id: "session-a",
			model: "gpt-4o-mini",
			selectedPackId: groundedResearchDefault.id,
			lastClassicModel: "gpt-4o-mini",
		});
		const view = new ChatView({ app } as never, deps);
		const parent = renderPackTurn(view, createAgentWorkTurn({
			researchMarkdown:
				"Alpha is supported by the source note. [1](openagent://citation/1)\n\nAlpha is still supported later. [1](openagent://citation/1)",
			citations: [
				{
					claimId: "claim-verified",
					notePath: "notes/source.md",
					exactPhrase: "Alpha evidence",
					startOffset: 0,
					endOffset: "Alpha evidence".length,
					occurrenceIndex: 0,
				},
			],
		}));
		const citationLinks = findByClass(parent, "open-agent-citation-link");
		expect(citationLinks.map((el) => el.textContent)).toEqual(["[1]", "[1]"]);

		citationLinks[0].click();
		await Promise.resolve();
		await Promise.resolve();
		expect(openFile).toHaveBeenCalledWith(
			expect.objectContaining({ path: "notes/source.md" }),
			expect.objectContaining({
				eState: {
					selection: {
						from: { line: 1, ch: 0 },
						to: { line: 1, ch: "Alpha evidence".length },
					},
				},
			}),
		);

		const fallbackParent = renderPackTurn(view, createAgentWorkTurn({
			citations: [
				{
					claimId: "claim-verified",
					notePath: "notes/source.md",
					exactPhrase: "Missing phrase",
					startOffset: 0,
					endOffset: "Missing phrase".length,
					occurrenceIndex: 0,
				},
			],
			researchMarkdown: "Broken link [1](openagent://citation/1)",
		}));
		findByClass(fallbackParent, "open-agent-citation-link")[0].click();
		await Promise.resolve();
		await Promise.resolve();
		expect(NoticeMock).toHaveBeenCalledWith("Citation target no longer matches the live note.");
		expect(openFile).toHaveBeenLastCalledWith(expect.objectContaining({ path: "notes/source.md" }));
	});

	it("renders safely when researchMarkdown, citations, or anchors are absent and shows the locked no-result fallback copy", () => {
		const app = createMockApp();
		const { deps } = createDeps({
			id: "session-a",
			model: "gpt-4o-mini",
			selectedPackId: groundedResearchDefault.id,
			lastClassicModel: "gpt-4o-mini",
		});
		const view = new ChatView({ app } as never, deps);
		const parent = renderPackTurn(view, createAgentWorkTurn({
			researchMarkdown: undefined,
			citations: undefined,
		}));

		expect(textTree(parent)).toContain("Research result unavailable");
		expect(textTree(parent)).toContain("How this answer was built");
		expect(textTree(parent)).toContain(
			"This run did not produce a citation-ready research answer. Review the completed steps and claim details below, then rerun research if needed.",
		);
		expect(findByClass(parent, "open-agent-citation-link")).toHaveLength(0);
	});

	it("ships transcript-local redesign styles with touch-safe step rows, inline citations, and a capped monospace JSON block", () => {
		expect(agentWorkStyles).toContain(".open-agent-pack-step");
		expect(agentWorkStyles).toContain(".open-agent-pack-result");
		expect(agentWorkStyles).toContain(".open-agent-pack-progress-title");
		expect(agentWorkStyles).toContain(".open-agent-pack-progress-title.is-stopping");
		expect(agentWorkStyles).toContain(".open-agent-pack-step-state");
		expect(agentWorkStyles).toContain(".open-agent-pack-step.is-expandable");
		expect(agentWorkStyles).toContain("overflow-wrap: anywhere");
		expect(agentWorkStyles).toContain(".open-agent-pack-step.is-stopping");
		expect(agentWorkStyles).toContain(".open-agent-pack-step.is-stopped");
		expect(agentWorkStyles).toContain(".open-agent-pack-step-disclosure");
		expect(agentWorkStyles).toContain(".open-agent-pack-step.is-expanded");
		expect(agentWorkStyles).toContain(".open-agent-pack-step-details");
		expect(agentWorkStyles).toContain(".open-agent-citation-link");
		expect(agentWorkStyles).toContain("min-height: 44px");
		expect(agentWorkStyles).toContain("cursor: pointer");
		expect(agentWorkStyles).toContain(".open-agent-work-raw-json");
		expect(agentWorkStyles).toContain("font-family: var(--font-monospace)");
		expect(agentWorkStyles).toContain("max-height: 240px");
		expect(agentWorkStyles).toContain("overflow-x: auto");
		expect(agentWorkStyles).toContain("overflow-y: auto");
		expect(agentWorkStyles).toContain("max-height: 30vh");
	});

	it("shows a recovery banner when the active session was restored from corrupt history", () => {
		const app = createMockApp();
		const { deps } = createDeps({
			id: "session-a",
			model: "gpt-4o-mini",
			selectedPackId: null,
			lastClassicModel: "gpt-4o-mini",
			recovery: {
				reason: "turns-corrupt",
				message: "Saved chat history was unreadable. OpenAgent moved the original file to sessions/session-a.corrupt-123.json and reset this chat to an empty history.",
				backupPath: "sessions/session-a.corrupt-123.json",
				recoveredAt: 123,
			},
		});
		const view = new ChatView({ app } as never, deps);
		const sessionTitleEl = new MockElement("span");
		const modelInputEl = new MockElement("input");
		modelInputEl.parentElement = new MockElement("div");
		const modeSelectEl = new MockElement("select");
		const packSummaryEl = new MockElement("div");
		const packHintEl = new MockElement("div");
		const packRecoveryEl = new MockElement("div");
		const packMobileBannerEl = new MockElement("div");
		const sessionRecoveryEl = new MockElement("div");

		Object.assign(view as unknown as Record<string, unknown>, {
			sessionTitleEl,
			modelInputEl,
			modeSelectEl,
			packSummaryEl,
			packHintEl,
			packRecoveryEl,
			packMobileBannerEl,
			sessionRecoveryEl,
			availablePacks: [],
		});

		(view as unknown as { refreshHeader(): void }).refreshHeader();

		const banners = findByClass(sessionRecoveryEl, "open-agent-pack-banner");
		expect(banners).toHaveLength(1);
		expect(banners[0]?.textContent).toContain("sessions/session-a.corrupt-123.json");
	});

	it("orders text model options as default, override, global, then the full list", () => {
		const app = createMockApp();
		const { deps } = createDeps({
			id: "session-a",
			model: "session-model",
			textModel: "override-model",
			selectedPackId: null,
			lastClassicModel: "session-model",
		});
		deps.getSettings = () => ({ ...DEFAULT_SETTINGS, apiKey: "token", model: "gpt-4o-mini" });
		const view = new ChatView({ app } as never, deps);
		const select = new MockElement("select");
		Object.assign(view as unknown as Record<string, unknown>, {
			modelInputEl: select,
			textModelCatalog: ["gpt-4o-mini", "override-model", "catalog-a"],
		});
		(view as unknown as { refreshTextModelOptions(): void }).refreshTextModelOptions();
		expect(optionValuesOf(select)).toEqual([
			"",
			"override-model",
			"gpt-4o-mini",
			"gpt-4o-mini",
			"override-model",
			"catalog-a",
		]);
		expect(groupLabelsOf(select)).toEqual(["All models"]);
	});

	it("keeps a stored text model the catalog missed", () => {
		const app = createMockApp();
		const { deps } = createDeps({
			id: "session-a",
			model: "session-model",
			textModel: "gone-model",
			selectedPackId: null,
			lastClassicModel: "session-model",
		});
		deps.getSettings = () => ({ ...DEFAULT_SETTINGS, apiKey: "token", model: "gpt-4o-mini" });
		const view = new ChatView({ app } as never, deps);
		const select = new MockElement("select");
		Object.assign(view as unknown as Record<string, unknown>, {
			modelInputEl: select,
			textModelCatalog: ["gpt-4o-mini", "catalog-a"],
		});
		(view as unknown as { refreshTextModelOptions(): void }).refreshTextModelOptions();
		expect(select.value).toBe("gone-model");
		expect(optionValuesOf(select)).toEqual(["", "gone-model", "gpt-4o-mini", "gpt-4o-mini", "catalog-a"]);
	});

	it("keeps a stored default text model the catalog missed", () => {
		const app = createMockApp();
		const { deps } = createDeps({
			id: "session-a",
			model: "gone-global",
			selectedPackId: null,
			lastClassicModel: "gone-global",
		});
		deps.getSettings = () => ({ ...DEFAULT_SETTINGS, apiKey: "token", model: "gone-global" });
		const view = new ChatView({ app } as never, deps);
		const select = new MockElement("select");
		Object.assign(view as unknown as Record<string, unknown>, {
			modelInputEl: select,
			textModelCatalog: ["catalog-a"],
		});
		(view as unknown as { refreshTextModelOptions(): void }).refreshTextModelOptions();
		expect(select.children[0]?.textContent).toBe("Default: gone-global");
		expect(optionValuesOf(select)).toEqual(["", "gone-global", "catalog-a"]);
	});

	it("still drops a stored text model that cannot serve text", () => {
		const app = createMockApp();
		const { deps } = createDeps({
			id: "session-a",
			model: "session-model",
			textModel: "catalog-a:batch",
			selectedPackId: null,
			lastClassicModel: "session-model",
		});
		deps.getSettings = () => ({ ...DEFAULT_SETTINGS, apiKey: "token", model: "gpt-4o-mini" });
		const view = new ChatView({ app } as never, deps);
		const select = new MockElement("select");
		Object.assign(view as unknown as Record<string, unknown>, {
			modelInputEl: select,
			textModelCatalog: ["gpt-4o-mini", "catalog-a"],
		});
		(view as unknown as { refreshTextModelOptions(): void }).refreshTextModelOptions();
		expect(select.value).toBe("");
		expect(optionValuesOf(select)).toEqual(["", "gpt-4o-mini", "gpt-4o-mini", "catalog-a"]);
	});

	it("keeps a stored image model the catalog missed", () => {
		const app = createMockApp();
		const { deps } = createDeps({
			id: "session-a",
			model: "session-model",
			imageModel: "gone-image",
			selectedPackId: null,
			lastClassicModel: "session-model",
		});
		deps.getSettings = () => ({ ...DEFAULT_SETTINGS, apiKey: "token", imageModel: "img-a" });
		const view = new ChatView({ app } as never, deps);
		const imageSelect = new MockElement("select");
		Object.assign(view as unknown as Record<string, unknown>, {
			imageModelInputEl: imageSelect,
			imageModelCatalog: ["img-a"],
		});
		(view as unknown as { refreshImageModelOptions(): void }).refreshImageModelOptions();
		expect(imageSelect.value).toBe("gone-image");
		expect(optionValuesOf(imageSelect)).toEqual(["", "gone-image", "img-a", "img-a"]);
	});

	it("still drops a stored image model the catalog knows cannot serve images", async () => {
		const app = createMockApp();
		const { deps } = createDeps({
			id: "session-a",
			model: "session-model",
			imageModel: "text-only-id",
			selectedPackId: null,
			lastClassicModel: "session-model",
		});
		deps.getSettings = () => ({
			...DEFAULT_SETTINGS,
			baseUrl: "https://example.test/v1",
			apiKey: "token",
			imageModel: "img-only-id",
		});
		const view = new ChatView({ app } as never, deps);
		const imageSelect = new MockElement("select");
		Object.assign(view as unknown as Record<string, unknown>, { imageModelInputEl: imageSelect });
		requestUrlMock.mockResolvedValue({
			status: 200,
			text: JSON.stringify({
				data: [
					{ id: "text-only-id", architecture: { output_modalities: ["text"] } },
					{ id: "img-only-id", architecture: { output_modalities: ["image"] } },
				],
			}),
		});
		await (view as unknown as { populateModelDatalist(): Promise<void> }).populateModelDatalist();
		(view as unknown as { refreshImageModelOptions(): void }).refreshImageModelOptions();
		expect(imageSelect.value).toBe("");
		expect(optionValuesOf(imageSelect)).toEqual(["", "img-only-id", "img-only-id"]);
	});

	it("uses the stored image default for a request when the catalog missed it", () => {
		const app = createMockApp();
		const { deps } = createDeps({
			id: "session-a",
			model: "session-model",
			selectedPackId: null,
			lastClassicModel: "session-model",
		});
		deps.getSettings = () => ({ ...DEFAULT_SETTINGS, apiKey: "token", imageModel: "gone-image" });
		const view = new ChatView({ app } as never, deps);
		const imageSelect = new MockElement("select");
		Object.assign(view as unknown as Record<string, unknown>, {
			imageModelInputEl: imageSelect,
			imageModelCatalog: ["catalog-a"],
		});
		const resolve = (view as unknown as { getImageModelForSend(settings: unknown): string }).getImageModelForSend.bind(view);
		expect(resolve(deps.getSettings())).toBe("gone-image");
		imageSelect.value = "session-image";
		expect(resolve(deps.getSettings())).toBe("session-image");
	});

	it("shows a category section above the full list and disables a missing member", () => {
		const app = createMockApp();
		const { deps } = createDeps({
			id: "session-a",
			model: "session-model",
			textModel: "override-model",
			selectedPackId: null,
			lastClassicModel: "session-model",
		});
		deps.getSettings = () => ({
			...DEFAULT_SETTINGS,
			apiKey: "token",
			model: "gpt-4o-mini",
			modelCategories: [
				{ id: "cat-1", name: "Favourites", kind: "text", models: ["catalog-a", "gone"] },
				{ id: "cat-2", name: "Images", kind: "image", models: ["only-an-image-id"] },
			],
		});
		const view = new ChatView({ app } as never, deps);
		const select = new MockElement("select");
		Object.assign(view as unknown as Record<string, unknown>, {
			modelInputEl: select,
			textModelCatalog: ["gpt-4o-mini", "override-model", "catalog-a"],
		});
		(view as unknown as { refreshTextModelOptions(): void }).refreshTextModelOptions();
		// The image-only category adds no section here: none of its members is in the text catalog.
		expect(groupLabelsOf(select)).toEqual(["Favourites", "All models"]);
		expect(optionValuesOf(select)).toEqual([
			"",
			"override-model",
			"gpt-4o-mini",
			"catalog-a",
			"gone",
			"gpt-4o-mini",
			"override-model",
			"catalog-a",
		]);
		const gone = select.children[3]?.children[1];
		expect(gone?.disabled).toBe(true);
	});

	it("fills both catalogs from one fetch and paints the sections", async () => {
		const app = createMockApp();
		const { deps } = createDeps({
			id: "session-a",
			model: "session-model",
			selectedPackId: null,
			lastClassicModel: "session-model",
		});
		deps.getSettings = () => ({
			...DEFAULT_SETTINGS,
			baseUrl: "https://example.test/v1",
			apiKey: "token",
			model: "m-text",
			modelCategories: [{ id: "cat-1", name: "Favourites", kind: "image", models: ["m-image"] }],
		});
		const view = new ChatView({ app } as never, deps);
		const select = new MockElement("select");
		const imageSelect = new MockElement("select");
		Object.assign(view as unknown as Record<string, unknown>, {
			modelInputEl: select,
			imageModelInputEl: imageSelect,
		});
		requestUrlMock.mockResolvedValue({
			status: 200,
			text: JSON.stringify({
				data: [
					{ id: "m-text", architecture: { output_modalities: ["text"] } },
					{ id: "m-image", architecture: { output_modalities: ["image"] } },
				],
			}),
		});
		await (view as unknown as { populateModelDatalist(): Promise<void> }).populateModelDatalist();
		expect((view as unknown as { textModelCatalog: string[] }).textModelCatalog).toEqual(["m-text"]);
		expect(optionValuesOf(imageSelect)).toContain("m-image");
		expect(groupLabelsOf(imageSelect)).toEqual(["Favourites", "All models"]);
	});

	it("shows only same-kind categories in each chat dropdown", () => {
		const app = createMockApp();
		const { deps } = createDeps({
			id: "session-a",
			model: "session-model",
			selectedPackId: null,
			lastClassicModel: "session-model",
		});
		deps.getSettings = () => ({
			...DEFAULT_SETTINGS,
			apiKey: "token",
			model: "m-text",
			modelCategories: [
				{ id: "cat-text", name: "Writing", kind: "text", models: ["m-text"] },
				{ id: "cat-image", name: "Pictures", kind: "image", models: ["m-image"] },
			],
		});
		const view = new ChatView({ app } as never, deps);
		const textSelect = new MockElement("select");
		const imageSelect = new MockElement("select");
		Object.assign(view as unknown as Record<string, unknown>, {
			modelInputEl: textSelect,
			imageModelInputEl: imageSelect,
			textModelCatalog: ["m-text", "m-image"],
			imageModelCatalog: ["m-text", "m-image"],
		});
		(view as unknown as { refreshTextModelOptions(): void }).refreshTextModelOptions();
		(view as unknown as { refreshImageModelOptions(): void }).refreshImageModelOptions();
		expect(groupLabelsOf(textSelect)).toEqual(["Writing", "All models"]);
		expect(groupLabelsOf(imageSelect)).toEqual(["Pictures", "All models"]);
	});

	it("falls back to the classic model for legacy sessions without a text override", () => {
		const app = createMockApp();
		const { deps } = createDeps({
			id: "session-a",
			model: "legacy-model",
			selectedPackId: null,
			lastClassicModel: "legacy-model",
		});
		deps.getSettings = () => ({ ...DEFAULT_SETTINGS, apiKey: "token", model: "gpt-4o-mini" });
		const view = new ChatView({ app } as never, deps);
		const override = (view as unknown as { getSessionTextOverride(): string }).getSessionTextOverride.bind(view);
		expect(override()).toBe("legacy-model");

		deps.getSettings = () => ({ ...DEFAULT_SETTINGS, apiKey: "token", model: "legacy-model" });
		expect(override()).toBe("");
	});
});

// ─── Streamed text rendering ─────────────────────────────────────────────────

type ViewDeps = ConstructorParameters<typeof ChatView>[1];

/** Browser timer surface that the view touches while a send is in flight. */
function oaWindowShim(): {
	setTimeout: (callback: () => void, ms?: number) => number;
	clearTimeout: (handle: number) => void;
} {
	return {
		setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms) as unknown as number,
		clearTimeout: (handle) => globalThis.clearTimeout(handle),
	};
}

/** One SSE record per pull, so the test can inspect the transcript between deltas. */
function oaDeltaStream(deltas: string[], opts: { delayMs?: number; onPull?: () => void } = {}): unknown {
	const encoder = new TextEncoder();
	const records = deltas.map((delta) =>
		encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: delta } }] })}\n\n`),
	);
	records.push(encoder.encode("data: [DONE]\n\n"));
	let index = 0;
	const body = new ReadableStream<Uint8Array>({
		async pull(controller) {
			opts.onPull?.();
			if (opts.delayMs) await new Promise<void>((resolve) => globalThis.setTimeout(resolve, opts.delayMs));
			if (index >= records.length) {
				controller.close();
				return;
			}
			controller.enqueue(records[index]);
			index += 1;
		},
	});
	return {
		ok: true,
		status: 200,
		headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? "text/event-stream" : null) },
		body,
		text: async () => "",
	};
}

function createTranscriptView(): { view: ChatView; transcriptEl: MockElement; deps: ViewDeps } {
	const app = createMockApp();
	const { deps } = createDeps({
		id: "session-a",
		model: "gpt-4o-mini",
		selectedPackId: null,
		lastClassicModel: "gpt-4o-mini",
	});
	const view = new ChatView({ app } as never, deps);
	const transcriptEl = new MockElement("div");
	Object.assign(view as unknown as Record<string, unknown>, { transcriptEl });
	return { view, transcriptEl, deps };
}

function renderTranscriptOf(view: ChatView): void {
	(view as unknown as { renderTranscript(): void }).renderTranscript();
}

interface AppendTurn {
	role: "assistant";
	content: string;
	segments: Array<{ kind: "text"; text: string }>;
	toolCallMap: Record<string, never>;
	thinking: boolean;
	generatedImages: never[];
}

interface AppendSegment {
	kind: "text";
	text: string;
}

function appendStreamedTextOf(view: ChatView, turn: AppendTurn): void {
	(view as unknown as { appendStreamedText(turn: AppendTurn): void }).appendStreamedText(turn);
}

/** A busy streamed turn whose body element is already cached, so appends take the in-place path. */
function createAppendingView(text: string): {
	view: ChatView;
	transcriptEl: MockElement;
	turn: AppendTurn;
	segment: AppendSegment;
} {
	const { view, transcriptEl } = createTranscriptView();
	const segment: AppendSegment = { kind: "text", text };
	const turn: AppendTurn = {
		role: "assistant",
		content: text,
		segments: [segment],
		toolCallMap: {},
		thinking: false,
		generatedImages: [],
	};
	Object.assign(view as unknown as Record<string, unknown>, { turns: [turn] });
	(view as unknown as { inFlights: Map<string, AbortController> }).inFlights.set("session-a", new AbortController());
	renderTranscriptOf(view);
	return { view, transcriptEl, turn, segment };
}

function appendDelta(view: ChatView, turn: AppendTurn, segment: AppendSegment, text: string): void {
	segment.text = text;
	turn.content = text;
	appendStreamedTextOf(view, turn);
}

/** A view wired with every element the classic send path touches. */
function createSendView(): { view: ChatView; transcriptEl: MockElement; inputEl: MockElement } {
	const { view, transcriptEl, deps } = createTranscriptView();
	Object.assign(deps, { tools: { list: () => [] } as never });
	const sessionStore = {
		getActive: () => ({
			id: "session-a",
			title: "Session",
			createdAt: 1,
			updatedAt: 1,
			turns: [],
			model: "gpt-4o-mini",
			lastClassicModel: "gpt-4o-mini",
		}),
		getSessions: () => [],
		rename: vi.fn(async () => undefined),
		updateModel: vi.fn(async () => undefined),
		updateTurns: vi.fn(async () => undefined),
	};
	Object.assign(deps, { sessionStore: sessionStore as never });
	const inputEl = new MockElement("textarea");
	Object.assign(view as unknown as Record<string, unknown>, {
		transcriptEl,
		inputEl,
		modelInputEl: new MockElement("input"),
		imageModelInputEl: new MockElement("input"),
		sendBtn: new MockElement("button"),
		stopBtn: new MockElement("button"),
	});
	return { view, transcriptEl, inputEl };
}

describe("ChatView streamed text", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("appends streamed text in place instead of rebuilding the transcript", async () => {
		vi.stubGlobal("window", oaWindowShim());
		const { view, transcriptEl, inputEl } = createSendView();
		const emptySpy = vi.spyOn(transcriptEl, "empty");
		const pulls: Array<{ emptyCalls: number; bodies: MockElement[]; texts: string[] }> = [];
		fetchMock.mockResolvedValue(
			oaDeltaStream(["a", "b", "c"], {
				delayMs: 60,
				onPull: () => {
					const assistantRow = findByClass(transcriptEl, "open-agent-turn-assistant")[0];
					const bodies = assistantRow ? findByClass(assistantRow, "open-agent-turn-body") : [];
					pulls.push({
						emptyCalls: emptySpy.mock.calls.length,
						bodies,
						texts: bodies.map((body) => body.textContent),
					});
				},
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		inputEl.value = "hello";
		await (view as unknown as { handleSend(): Promise<void> }).handleSend();

		const bodyPulls = pulls.filter((pull) => pull.bodies.length > 0);
		expect(bodyPulls.length).toBeGreaterThan(1);
		const firstBody = bodyPulls[0].bodies[0];
		for (const pull of bodyPulls) {
			expect(pull.bodies).toHaveLength(1);
			expect(pull.bodies[0]).toBe(firstBody);
			expect(pull.emptyCalls).toBe(bodyPulls[0].emptyCalls);
		}
		const texts = bodyPulls.map((pull) => pull.texts[0]);
		expect(texts[0]).toBe("a");
		expect(texts[texts.length - 1]).toBe("abc");
		expect(textTree(transcriptEl)).toContain("abc");
	});

	it("only scrolls to the bottom when the reader is already near it", () => {
		const { view, transcriptEl } = createTranscriptView();
		transcriptEl.scrollHeight = 1000;
		transcriptEl.clientHeight = 500;
		transcriptEl.scrollTop = 10;

		renderTranscriptOf(view);
		expect(transcriptEl.scrollTop).toBe(10);

		transcriptEl.scrollTop = 500;
		renderTranscriptOf(view);
		expect(transcriptEl.scrollTop).toBe(1000);
	});

	it("follows the stream when the reader is at the bottom", () => {
		const { view, transcriptEl, turn, segment } = createAppendingView("hello");
		transcriptEl.scrollHeight = 1000;
		transcriptEl.clientHeight = 500;
		transcriptEl.scrollTop = 500;

		appendDelta(view, turn, segment, "hello there");

		expect(segment.text).toBe("hello there");
		expect(transcriptEl.scrollTop).toBe(1000);
	});

	it("leaves the view alone when the reader has scrolled away", () => {
		const { view, transcriptEl, turn, segment } = createAppendingView("hello");
		transcriptEl.scrollHeight = 1000;
		transcriptEl.clientHeight = 500;
		transcriptEl.scrollTop = 10;

		appendDelta(view, turn, segment, "hello there");

		expect(segment.text).toBe("hello there");
		expect(transcriptEl.scrollTop).toBe(10);
	});

	it("scrolls at 32 px from the bottom and stops at 33 px", () => {
		const { view, transcriptEl, turn, segment } = createAppendingView("hello");
		transcriptEl.scrollHeight = 1000;
		transcriptEl.clientHeight = 500;
		transcriptEl.scrollTop = 467;

		appendDelta(view, turn, segment, "hello there");
		expect(transcriptEl.scrollTop).toBe(467);

		transcriptEl.scrollTop = 468;
		appendDelta(view, turn, segment, "hello there again");
		expect(transcriptEl.scrollTop).toBe(1000);
	});

	it("names the plain-text fallback instead of claiming the endpoint cannot stream", () => {
		const { view, transcriptEl } = createTranscriptView();
		(view as unknown as { turns: unknown[] }).turns = [
			{
				role: "assistant",
				content: "",
				segments: [{ kind: "text", text: "fallback answer" }],
				toolCallMap: {},
				thinking: false,
				generatedImages: [],
				degraded: true,
			},
		];

		renderTranscriptOf(view);

		const tree = textTree(transcriptEl);
		expect(tree).toContain("Response format unsupported — this reply used the plain-text fallback.");
		expect(tree).not.toContain("Non-streaming response");
	});

	it("finishes the turn when the stream ends without a finish reason", async () => {
		vi.stubGlobal("window", oaWindowShim());
		const { view, transcriptEl, inputEl } = createSendView();
		fetchMock.mockResolvedValue(oaDeltaStream(["streamed", " answer"]));
		vi.stubGlobal("fetch", fetchMock);

		inputEl.value = "hello";
		await (view as unknown as { handleSend(): Promise<void> }).handleSend();

		expect((view as unknown as { inFlights: Map<string, unknown> }).inFlights.size).toBe(0);
		expect(textTree(transcriptEl)).toContain("streamed answer");
	});
});

// ─── Thoughts block and persisted reasoning ─────────────────────────────────

interface ThoughtsTurn {
	role: "assistant";
	content: string;
	segments: Array<{ kind: "text"; text: string }>;
	toolCallMap: Record<string, never>;
	thinking: boolean;
	generatedImages: never[];
	thinkingContent?: string;
	finishReason?: FinishReason;
}

interface StoredTurnsCast {
	uiToStoredTurns(turns: unknown[]): Array<Record<string, unknown>>;
}

interface UiTurnsCast {
	storedToUiTurns(turns: unknown[]): Promise<ThoughtsTurn[]>;
}

const EMPTY_REPLY_LINE = "The model used its whole output budget on reasoning, so it returned no answer.";

function thoughtTurn(overrides: Partial<ThoughtsTurn> = {}): ThoughtsTurn {
	return {
		role: "assistant",
		content: "",
		segments: [],
		toolCallMap: {},
		thinking: false,
		generatedImages: [],
		...overrides,
	};
}

function createThoughtsView(turns: ThoughtsTurn[]): { view: ChatView; transcriptEl: MockElement } {
	const { view, transcriptEl } = createTranscriptView();
	(view as unknown as { turns: ThoughtsTurn[] }).turns = turns;
	return { view, transcriptEl };
}

function thoughtsContentOf(transcriptEl: MockElement): string[] {
	return findByClass(transcriptEl, "open-agent-turn-thoughts-content").map((el) => el.textContent);
}

/** Click the single thoughts toggle in the transcript, the way a reader does. */
function clickThoughtsToggle(transcriptEl: MockElement): void {
	const toggles = findByClass(transcriptEl, "open-agent-turn-thoughts-toggle");
	expect(toggles).toHaveLength(1);
	toggles[0].click();
}

function storedTurnsOf(view: ChatView, turns: unknown[]): Array<Record<string, unknown>> {
	return (view as unknown as StoredTurnsCast).uiToStoredTurns(turns);
}

async function uiTurnsOf(view: ChatView, stored: unknown[]): Promise<ThoughtsTurn[]> {
	return (view as unknown as UiTurnsCast).storedToUiTurns(stored);
}

/** An SSE stream that spends its whole budget on reasoning and stops on length. */
function oaReasoningOnlyStream(): unknown {
	const encoder = new TextEncoder();
	const records = [
		encoder.encode(
			`data: ${JSON.stringify({ choices: [{ delta: { reasoning: "17 * 23 = 391" }, finish_reason: null }] })}\n\n`,
		),
		encoder.encode(
			`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "length" }] })}\n\n`,
		),
		encoder.encode("data: [DONE]\n\n"),
	];
	let index = 0;
	const body = new ReadableStream<Uint8Array>({
		async pull(controller) {
			if (index >= records.length) {
				controller.close();
				return;
			}
			controller.enqueue(records[index]);
			index += 1;
		},
	});
	return {
		ok: true,
		status: 200,
		headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? "text/event-stream" : null) },
		body,
		text: async () => "",
	};
}

describe("ChatView thoughts block", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("collapses the thoughts block by default", () => {
		const { view, transcriptEl } = createThoughtsView([
			thoughtTurn({ segments: [{ kind: "text", text: "391" }], thinkingContent: "17 * 23 = 391" }),
		]);

		renderTranscriptOf(view);

		expect(findByClass(transcriptEl, "open-agent-turn-thoughts-toggle")).toHaveLength(1);
		expect(thoughtsContentOf(transcriptEl)).toEqual([]);
		expect(textTree(transcriptEl)).not.toContain("17 * 23 = 391");
	});

	it("opens and closes the thoughts block when the reader clicks the toggle", () => {
		const { view, transcriptEl } = createThoughtsView([
			thoughtTurn({ segments: [{ kind: "text", text: "391" }], thinkingContent: "17 * 23 = 391" }),
		]);

		renderTranscriptOf(view);
		expect(thoughtsContentOf(transcriptEl)).toEqual([]);

		clickThoughtsToggle(transcriptEl);
		expect(thoughtsContentOf(transcriptEl)).toEqual(["17 * 23 = 391"]);

		clickThoughtsToggle(transcriptEl);
		expect(thoughtsContentOf(transcriptEl)).toEqual([]);
	});

	it("stores the reasoning with the assistant turn and restores it", async () => {
		const { view } = createTranscriptView();

		const stored = storedTurnsOf(view, [
			thoughtTurn({ segments: [{ kind: "text", text: "391" }], thinkingContent: "17 * 23 = 391" }),
		]);
		expect(stored).toEqual([{ role: "assistant", content: "391", thinking: "17 * 23 = 391" }]);

		const restored = await uiTurnsOf(view, stored);
		expect(restored).toHaveLength(1);
		expect(restored[0].thinkingContent).toBe("17 * 23 = 391");
		expect(restored[0].segments).toEqual([{ kind: "text", text: "391" }]);
	});

	it("stores a turn that used its whole budget on reasoning", async () => {
		const { view } = createTranscriptView();

		const stored = storedTurnsOf(view, [
			thoughtTurn({ thinkingContent: "17 * 23 = 391", finishReason: "length" }),
		]);
		expect(stored).toEqual([{ role: "assistant", content: "", thinking: "17 * 23 = 391" }]);

		const restored = await uiTurnsOf(view, stored);
		expect(restored[0].thinkingContent).toBe("17 * 23 = 391");
	});

	it("writes no thinking field when the turn has no reasoning", () => {
		const { view } = createTranscriptView();

		const stored = storedTurnsOf(view, [
			thoughtTurn({ segments: [{ kind: "text", text: "391" }] }),
			thoughtTurn({ thinkingContent: "   " }),
		]);

		expect(stored).toEqual([{ role: "assistant", content: "391" }]);
	});

	it("leaves the reasoning undefined for a session written before it was stored", async () => {
		const { view } = createTranscriptView();

		const restored = await uiTurnsOf(view, [{ role: "assistant", content: "old answer" }]);

		expect(restored).toHaveLength(1);
		expect(restored[0].thinkingContent).toBeUndefined();
		expect(restored[0].segments).toEqual([{ kind: "text", text: "old answer" }]);
	});

	it("shows the empty-reply line when the stream spent its budget on reasoning", async () => {
		vi.stubGlobal("window", oaWindowShim());
		const { view, transcriptEl, inputEl } = createSendView();
		fetchMock.mockResolvedValue(oaReasoningOnlyStream());
		vi.stubGlobal("fetch", fetchMock);

		inputEl.value = "what is 17 * 23";
		await (view as unknown as { handleSend(): Promise<void> }).handleSend();

		const tree = textTree(transcriptEl);
		expect(tree).toContain(EMPTY_REPLY_LINE);
		expect(findByClass(transcriptEl, "open-agent-turn-thoughts-content")).toHaveLength(0);
		expect(findByClass(transcriptEl, "open-agent-turn-thoughts-toggle")).toHaveLength(1);
	});

	it("renders the empty-reply line for a restored turn that stopped on length", () => {
		const { view, transcriptEl } = createThoughtsView([
			thoughtTurn({ thinkingContent: "17 * 23 = 391", finishReason: "length" }),
		]);

		renderTranscriptOf(view);

		expect(textTree(transcriptEl)).toContain(EMPTY_REPLY_LINE);
	});

	it("omits the empty-reply line when the turn has text", () => {
		const { view, transcriptEl } = createThoughtsView([
			thoughtTurn({ segments: [{ kind: "text", text: "391" }], thinkingContent: "17 * 23 = 391", finishReason: "length" }),
		]);

		renderTranscriptOf(view);

		expect(textTree(transcriptEl)).not.toContain(EMPTY_REPLY_LINE);
	});

	it("omits the empty-reply line when the stream finished normally", () => {
		const { view, transcriptEl } = createThoughtsView([
			thoughtTurn({ thinkingContent: "17 * 23 = 391", finishReason: "stop" }),
		]);

		renderTranscriptOf(view);

		expect(textTree(transcriptEl)).not.toContain(EMPTY_REPLY_LINE);
	});
});

// ─── Composer ───────────────────────────────────────────────────────────────

/** Build the composer through the real open path and return its textarea. */
async function openComposerOf(): Promise<MockElement> {
	const { view } = createTranscriptView();
	const internals = view as unknown as {
		populateModelDatalist(): Promise<void>;
		refreshPacks(): Promise<void>;
		contentEl: MockElement;
	};
	internals.populateModelDatalist = async () => undefined;
	internals.refreshPacks = async () => undefined;
	vi.stubGlobal("window", { ...oaWindowShim(), addEventListener: (): void => undefined });
	await view.onOpen();

	const inputEl = findByClass(internals.contentEl, "open-agent-input")[0];
	if (!inputEl) throw new Error("the composer textarea is missing");
	return inputEl;
}

describe("ChatView composer", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("hints the mobile keyboard on the composer", async () => {
		const composerEl = await openComposerOf();

		expect(composerEl.attrs.enterkeyhint).toBe("enter");
		expect(composerEl.attrs.autocapitalize).toBe("sentences");
	});
});

// ─── Provider error reporting ────────────────────────────────────────────────

interface ErrorTurn {
	role: "assistant";
	content: string;
	segments: never[];
	toolCallMap: Record<string, never>;
	thinking: boolean;
	error?: string;
	authError?: boolean;
}

const NETWORK_SENTENCE = "Network error. Check your connection or endpoint and retry.";

function errorTurn(): ErrorTurn {
	return { role: "assistant", content: "", segments: [], toolCallMap: {}, thinking: true };
}

function applyErrorToTurnOf(view: ChatView, turn: ErrorTurn, error: unknown): void {
	(view as unknown as { applyErrorToTurn(t: ErrorTurn, e: unknown): void }).applyErrorToTurn(turn, error);
}

function formatPackRecoveryMessageOf(view: ChatView, packName: string, error: unknown): string {
	return (view as unknown as { formatPackRecoveryMessage(p: string, e: unknown): string }).formatPackRecoveryMessage(packName, error);
}

describe("ChatView provider error reporting", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("keeps the underlying network detail in the turn error", () => {
		const { view } = createTranscriptView();
		const turn = errorTurn();

		applyErrorToTurnOf(view, turn, new NetworkError("connect ECONNREFUSED 127.0.0.1:11434"));

		expect(turn.error).toBe(`${NETWORK_SENTENCE} (connect ECONNREFUSED 127.0.0.1:11434)`);
		expect(turn.thinking).toBe(false);
	});

	it("keeps the plain sentence alone when there is no detail", () => {
		const { view } = createTranscriptView();
		const empty = errorTurn();
		const defaulted = errorTurn();

		applyErrorToTurnOf(view, empty, new NetworkError());
		applyErrorToTurnOf(view, defaulted, new NetworkError("Network error"));

		expect(empty.error).toBe(NETWORK_SENTENCE);
		expect(defaulted.error).toBe(NETWORK_SENTENCE);
	});

	it("keeps the auth failure flagged and still carries the detail", () => {
		const { view } = createTranscriptView();
		const turn = errorTurn();

		applyErrorToTurnOf(view, turn, new AuthError("HTTP 401"));

		expect(turn.authError).toBe(true);
		expect(turn.error).toBe("Authentication failed — check your API key. (HTTP 401)");
		expect(turn.thinking).toBe(false);
	});

	it("carries the underlying detail in a pack recovery message", () => {
		const { view } = createTranscriptView();

		const network = formatPackRecoveryMessageOf(view, "Researcher", new NetworkError("connect ECONNREFUSED"));
		const auth = formatPackRecoveryMessageOf(view, "Researcher", new AuthError("HTTP 401"));

		expect(network.startsWith("Researcher couldn’t reach its provider.")).toBe(true);
		expect(network.endsWith("(connect ECONNREFUSED)")).toBe(true);
		expect(auth.startsWith("Researcher couldn’t authenticate.")).toBe(true);
		expect(auth.endsWith("(HTTP 401)")).toBe(true);
	});

	it("never puts the API key in the message or the log", async () => {
		vi.stubGlobal("window", oaWindowShim());
		const apiKey = "sk-live-sk-test-1234567890abcdef";
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const { view, inputEl } = createSendView();
		(view as unknown as { deps: ViewDeps }).deps.getSettings = () => ({ ...DEFAULT_SETTINGS, apiKey });
		fetchMock.mockRejectedValue(new Error(`socket hang up for Bearer ${apiKey}`));
		requestUrlMock.mockRejectedValue(new Error(`connect ECONNREFUSED while sending ${apiKey}`));
		vi.stubGlobal("fetch", fetchMock);

		inputEl.value = "hello";
		await (view as unknown as { handleSend(): Promise<void> }).handleSend();

		const turns = (view as unknown as { turns: ErrorTurn[] }).turns;
		const error = turns[turns.length - 1]?.error ?? "";
		expect(error).toContain("connect ECONNREFUSED");
		expect(error).not.toContain(apiKey);
		expect(errorSpy).toHaveBeenCalled();
		expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(apiKey);
		errorSpy.mockRestore();
	});
});
