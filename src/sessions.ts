import type { PackCitation, PackRunTransparency } from "./packs/runtime";
import type { PendingImage } from "./images/attachments";
import type { GeneratedImage } from "./types";
import { oaSanitizeGeneratedImages } from "./tools/image-generate";

export interface SessionMeta {
	id: string;
	title: string;
	model: string;
	textModel?: string | null;
	imageModel?: string;
	selectedPackId?: string | null;
	lastClassicModel?: string;
	createdAt: number;
	updatedAt: number;
}

export type StoredClaimStatus = "verified" | "unsupported" | "quote-missing";

export interface StoredPackProgressStep {
	id: string;
	label: string;
	state: "pending" | "running" | "complete" | "failed";
	message?: string;
}

export interface StoredPackClaim {
	id: string;
	text: string;
	sourceNote: string;
	sourceQuote: string;
	quotePresent: boolean;
	supportsClaim: boolean | null;
	supportExplanation: string;
	status: StoredClaimStatus;
	exactPhraseAnchor?: StoredExactPhraseAnchor;
}

export interface StoredExactPhraseAnchor {
	notePath: string;
	exactPhrase: string;
	startOffset: number;
	endOffset: number;
	occurrenceIndex: number;
}

export interface StoredPackTurnData {
	packId: string;
	packName: string;
	progressSteps?: StoredPackProgressStep[];
	retryingStepId?: string | null;
	error?: string;
	verifiedSummary?: string;
	researchMarkdown?: string;
	claims?: StoredPackClaim[];
	citations?: StoredPackCitation[];
	agentWork?: StoredPackTurnTransparency;
	modelsUsed?: {
		retriever: string;
		synthesizer: string;
		verifier: string;
	};
}

export type StoredPackTurnTransparency = PackRunTransparency;
export type StoredPackCitation = PackCitation;

export interface StoredTurn {
	role: "user" | "assistant";
	content: string;
	images?: PendingImage[];
	generatedImages?: GeneratedImage[];
	packTurn?: StoredPackTurnData;
}

export interface SessionRecoveryState {
	reason: "turns-corrupt";
	message: string;
	backupPath: string;
	recoveredAt: number;
}

export interface StoredSession extends SessionMeta {
	turns: StoredTurn[];
	recovery?: SessionRecoveryState | null;
}

export interface SessionReadResult {
	turns: StoredTurn[];
	recovery?: SessionRecoveryState;
}

export interface SessionFileAdapter {
	exists(path: string): Promise<boolean>;
	read(path: string): Promise<string>;
	write(path: string, data: string): Promise<void>;
	rename(path: string, newPath: string): Promise<void>;
}

interface Callbacks {
	persistIndex(meta: SessionMeta[], activeId: string): Promise<void>;
	readTurns(id: string): Promise<SessionReadResult>;
	writeTurns(id: string, turns: StoredTurn[]): Promise<void>;
	deleteTurns(id: string): Promise<void>;
}

function makeId(): string {
	return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function makeCorruptBackupPath(path: string, recoveredAt: number): string {
	const dotIndex = path.lastIndexOf(".");
	if (dotIndex === -1) return `${path}.corrupt-${recoveredAt}`;
	return `${path.slice(0, dotIndex)}.corrupt-${recoveredAt}${path.slice(dotIndex)}`;
}

async function recoverCorruptTurnsFile(
	adapter: SessionFileAdapter,
	path: string,
	recoveredAt: number,
): Promise<SessionReadResult> {
	const backupPath = makeCorruptBackupPath(path, recoveredAt);
	await adapter.rename(path, backupPath);
	await adapter.write(path, JSON.stringify({ turns: [] }));
	return {
		turns: [],
		recovery: {
			reason: "turns-corrupt",
			backupPath,
			recoveredAt,
			message: `Saved chat history was unreadable. OpenAgent moved the original file to ${backupPath} and reset this chat to an empty history.`,
		},
	};
}

export async function loadStoredTurnsFile({
	adapter,
	path,
	now = () => Date.now(),
}: {
	adapter: SessionFileAdapter;
	path: string;
	now?: () => number;
}): Promise<SessionReadResult> {
	if (!(await adapter.exists(path))) return { turns: [] };
	const rawText = await adapter.read(path);

	let parsed: unknown;
	try {
		parsed = JSON.parse(rawText) as unknown;
	} catch {
		return recoverCorruptTurnsFile(adapter, path, now());
	}

	if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { turns?: unknown }).turns)) {
		return recoverCorruptTurnsFile(adapter, path, now());
	}

	return { turns: sanitizeStoredTurns((parsed as { turns: unknown[] }).turns) };
}

export class SessionStore {
	private meta: SessionMeta[] = [];
	private activeId = "";
	private activeTurns: StoredTurn[] = [];
	private readonly recoveryById = new Map<string, SessionRecoveryState>();
	private readonly cb: Callbacks;

	constructor(cb: Callbacks) {
		this.cb = cb;
	}

	// rawSessions may include embedded turns (old data.json format) — migrated to files automatically.
	async init(rawSessions: (SessionMeta & { turns?: StoredTurn[] })[], activeId: string): Promise<void> {
		for (const s of rawSessions) {
			if (Array.isArray(s.turns) && s.turns.length > 0) {
				await this.cb.writeTurns(s.id, s.turns).catch(() => {});
			}
		}
		const meta: SessionMeta[] = rawSessions.map(({ id, title, model, textModel, imageModel, selectedPackId, lastClassicModel, createdAt, updatedAt }) => ({
			id,
			title,
			model,
			textModel: typeof textModel === "string" ? textModel : null,
			imageModel: typeof imageModel === "string" ? imageModel : "",
			selectedPackId: selectedPackId ?? null,
			lastClassicModel: lastClassicModel ?? model,
			createdAt,
			updatedAt,
		}));
		if (meta.length === 0) {
			const m = this.makeMeta();
			this.meta = [m];
			this.activeId = m.id;
			this.activeTurns = [];
		} else {
			this.meta = meta;
			this.activeId = meta.find((s) => s.id === activeId) ? activeId : meta[0].id;
			this.activeTurns = await this.loadTurns(this.activeId);
		}
	}

	getSessions(): SessionMeta[] {
		return this.meta;
	}

	getActiveId(): string {
		return this.activeId;
	}

	getActive(): StoredSession {
		const m = this.meta.find((s) => s.id === this.activeId) ?? this.meta[0] ?? this.makeMeta();
		return { ...m, turns: this.activeTurns, recovery: this.recoveryById.get(m.id) ?? null };
	}

	getRecoveryIssues(): SessionRecoveryState[] {
		return [...this.recoveryById.values()];
	}

	async create(): Promise<StoredSession> {
		const m = this.makeMeta();
		this.meta.push(m);
		this.activeId = m.id;
		this.activeTurns = [];
		await this.cb.persistIndex(this.meta, this.activeId);
		return { ...m, turns: [] };
	}

	async switchTo(id: string): Promise<void> {
		if (!this.meta.find((s) => s.id === id)) return;
		this.activeId = id;
		this.activeTurns = await this.loadTurns(id);
		await this.cb.persistIndex(this.meta, this.activeId);
	}

	async rename(id: string, title: string): Promise<void> {
		const m = this.meta.find((s) => s.id === id);
		if (!m) return;
		m.title = title;
		m.updatedAt = Date.now();
		await this.cb.persistIndex(this.meta, this.activeId);
	}

	async delete(id: string): Promise<void> {
		if (this.meta.length <= 1) {
			const m = this.meta[0];
			m.title = "New chat";
			m.model = "";
			m.textModel = "";
			m.imageModel = "";
			m.selectedPackId = null;
			m.lastClassicModel = "";
			m.updatedAt = Date.now();
			this.activeId = m.id;
			this.activeTurns = [];
			this.recoveryById.delete(m.id);
			await Promise.all([
				this.cb.persistIndex(this.meta, this.activeId),
				this.cb.writeTurns(m.id, []),
			]);
		} else {
			const idx = this.meta.findIndex((s) => s.id === id);
			if (idx === -1) return;
			this.meta.splice(idx, 1);
			this.recoveryById.delete(id);
			void this.cb.deleteTurns(id).catch(() => {});
			if (this.activeId === id) {
				const sorted = [...this.meta].sort((a, b) => b.updatedAt - a.updatedAt);
				this.activeId = sorted[0].id;
				this.activeTurns = await this.loadTurns(this.activeId);
			}
			await this.cb.persistIndex(this.meta, this.activeId);
		}
	}

	async updateTurns(id: string, turns: StoredTurn[]): Promise<void> {
		const m = this.meta.find((s) => s.id === id);
		if (!m) return;
		m.updatedAt = Date.now();
		if (id === this.activeId) this.activeTurns = turns;
		await Promise.all([
			this.cb.writeTurns(id, turns),
			this.cb.persistIndex(this.meta, this.activeId),
		]);
	}

	async updateModel(id: string, model: string): Promise<void> {
		const m = this.meta.find((s) => s.id === id);
		if (!m) return;
		m.textModel = model;
		if (model.trim().length > 0) {
			m.model = model;
			m.lastClassicModel = model;
		}
		m.updatedAt = Date.now();
		await this.cb.persistIndex(this.meta, this.activeId);
	}

	async updateImageModel(id: string, imageModel: string): Promise<void> {
		const m = this.meta.find((s) => s.id === id);
		if (!m) return;
		m.imageModel = imageModel;
		m.updatedAt = Date.now();
		await this.cb.persistIndex(this.meta, this.activeId);
	}

	async updateSelectedPack(id: string, selectedPackId: string | null, lastClassicModel?: string): Promise<void> {
		const m = this.meta.find((s) => s.id === id);
		if (!m) return;
		m.selectedPackId = selectedPackId;
		if (typeof lastClassicModel === "string") {
			m.lastClassicModel = lastClassicModel;
			if (lastClassicModel.trim().length > 0) m.model = lastClassicModel;
		}
		m.updatedAt = Date.now();
		await this.cb.persistIndex(this.meta, this.activeId);
	}

	toJSON(): { sessions: SessionMeta[]; activeSessionId: string } {
		return { sessions: this.meta, activeSessionId: this.activeId };
	}

	private async loadTurns(id: string): Promise<StoredTurn[]> {
		const result = await this.cb.readTurns(id);
		if (result.recovery) this.recoveryById.set(id, result.recovery);
		else this.recoveryById.delete(id);
		return result.turns;
	}

	private makeMeta(): SessionMeta {
		const now = Date.now();
		return {
			id: makeId(),
			title: "New chat",
			model: "",
			textModel: "",
			imageModel: "",
			selectedPackId: null,
			lastClassicModel: "",
			createdAt: now,
			updatedAt: now,
		};
	}
}

function sanitizeStoredTurns(turns: unknown[]): StoredTurn[] {
	return turns.map((turn) => sanitizeStoredTurn(turn));
}

function sanitizeStoredTurn(turn: unknown): StoredTurn {
	if (!turn || typeof turn !== "object") return turn as StoredTurn;
	const packTurn = (turn as { packTurn?: unknown }).packTurn;
	const hasGeneratedImages = Object.prototype.hasOwnProperty.call(turn, "generatedImages");
	if ((!packTurn || typeof packTurn !== "object") && !hasGeneratedImages) return turn as StoredTurn;
	const result = { ...(turn as StoredTurn) };
	if (packTurn && typeof packTurn === "object") {
		result.packTurn = sanitizeStoredPackTurn(packTurn);
	}
	if (hasGeneratedImages) {
		result.generatedImages = oaSanitizeGeneratedImages(
			(turn as { generatedImages?: unknown }).generatedImages,
		);
	}
	return result;
}

function sanitizeStoredPackTurn(turn: unknown): StoredPackTurnData {
	const packTurn = { ...(turn as StoredPackTurnData & Record<string, unknown>) };

	if (Object.prototype.hasOwnProperty.call(packTurn, "agentWork")) {
		const agentWork = sanitizeStoredPackTurnTransparency(packTurn.agentWork);
		if (agentWork === undefined) delete packTurn.agentWork;
		else packTurn.agentWork = agentWork;
	}

	if (Object.prototype.hasOwnProperty.call(packTurn, "claims")) {
		const claims = sanitizeOptionalStoredClaims(packTurn.claims);
		if (claims === undefined) delete packTurn.claims;
		else packTurn.claims = claims;
	}

	if (Object.prototype.hasOwnProperty.call(packTurn, "researchMarkdown")) {
		const researchMarkdown = sanitizeOptionalString(packTurn.researchMarkdown);
		if (researchMarkdown === undefined) delete packTurn.researchMarkdown;
		else packTurn.researchMarkdown = researchMarkdown;
	}

	if (Object.prototype.hasOwnProperty.call(packTurn, "citations")) {
		const citations = sanitizeOptionalStoredCitations(packTurn.citations);
		if (citations === undefined) delete packTurn.citations;
		else packTurn.citations = citations;
	}

	return packTurn as StoredPackTurnData;
}

function sanitizeStoredPackTurnTransparency(value: unknown): StoredPackTurnTransparency | undefined {
	if (!isRecord(value)) return undefined;
	const retriever = sanitizeRetrieverTransparency(value.retriever);
	const synthesizer = sanitizeSynthesizerTransparency(value.synthesizer);
	const verifier = sanitizeVerifierTransparency(value.verifier);
	const run = sanitizeRunTransparency(value.run);
	if (!retriever || !synthesizer || !verifier || !run) return undefined;
	return { retriever, synthesizer, verifier, run };
}

function sanitizeOptionalStoredClaims(value: unknown): StoredPackClaim[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) return undefined;
	const claims = value.map((claim) => sanitizeStoredPackClaim(claim));
	return claims.every((claim) => claim !== null) ? claims : undefined;
}

function sanitizeStoredPackClaim(value: unknown): StoredPackClaim | null {
	if (!isRecord(value)) return null;
	const status = sanitizeClaimStatus(value.status);
	const supportsClaim =
		value.supportsClaim === null || typeof value.supportsClaim === "boolean" ? value.supportsClaim : undefined;
	if (
		typeof value.id !== "string" ||
		typeof value.text !== "string" ||
		typeof value.sourceNote !== "string" ||
		typeof value.sourceQuote !== "string" ||
		typeof value.quotePresent !== "boolean" ||
		supportsClaim === undefined ||
		typeof value.supportExplanation !== "string" ||
		!status
	) {
		return null;
	}

	const claim: StoredPackClaim = {
		id: value.id,
		text: value.text,
		sourceNote: value.sourceNote,
		sourceQuote: value.sourceQuote,
		quotePresent: value.quotePresent,
		supportsClaim,
		supportExplanation: value.supportExplanation,
		status,
	};
	const exactPhraseAnchor = sanitizeOptionalExactPhraseAnchor(value.exactPhraseAnchor);
	if (exactPhraseAnchor !== undefined) claim.exactPhraseAnchor = exactPhraseAnchor;
	return claim;
}

function sanitizeOptionalStoredCitations(value: unknown): StoredPackCitation[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) return undefined;
	const citations = value.map((citation) => sanitizeStoredCitation(citation));
	return citations.every((citation) => citation !== null) ? citations : undefined;
}

function sanitizeStoredCitation(value: unknown): StoredPackCitation | null {
	if (!isRecord(value) || typeof value.claimId !== "string") return null;
	const anchor = sanitizeExactPhraseAnchor(value);
	if (anchor === null) return null;
	return {
		claimId: value.claimId,
		...anchor,
	};
}

function sanitizeOptionalExactPhraseAnchor(value: unknown): StoredExactPhraseAnchor | undefined {
	if (value === undefined) return undefined;
	return sanitizeExactPhraseAnchor(value) ?? undefined;
}

function sanitizeExactPhraseAnchor(value: unknown): StoredExactPhraseAnchor | null {
	if (!isRecord(value)) return null;
	const startOffset = sanitizeNumber(value.startOffset);
	const endOffset = sanitizeNumber(value.endOffset);
	const occurrenceIndex = sanitizeNumber(value.occurrenceIndex);
	if (
		typeof value.notePath !== "string" ||
		typeof value.exactPhrase !== "string" ||
		startOffset === undefined ||
		endOffset === undefined ||
		occurrenceIndex === undefined ||
		endOffset < startOffset
	) {
		return null;
	}
	return {
		notePath: value.notePath,
		exactPhrase: value.exactPhrase,
		startOffset,
		endOffset,
		occurrenceIndex,
	};
}

function sanitizeRetrieverTransparency(value: unknown): StoredPackTurnTransparency["retriever"] | null {
	if (!isRecord(value)) return null;
	const status = sanitizeCardStatus(value.status);
	if (!status) return null;
	const elapsedMs = sanitizeOptionalNumber(value.elapsedMs);
	const notesFoundCount = sanitizeOptionalNumber(value.notesFoundCount);
	const topNotePaths = sanitizeOptionalStringArray(value.topNotePaths);
	const brief = sanitizeOptionalString(value.brief);
	if (value.elapsedMs !== undefined && elapsedMs === undefined) return null;
	if (value.notesFoundCount !== undefined && notesFoundCount === undefined) return null;
	if (value.topNotePaths !== undefined && topNotePaths === undefined) return null;
	if (value.brief !== undefined && brief === undefined) return null;
	return {
		status,
		...(elapsedMs !== undefined ? { elapsedMs } : {}),
		...(notesFoundCount !== undefined ? { notesFoundCount } : {}),
		...(topNotePaths !== undefined ? { topNotePaths } : {}),
		...(brief !== undefined ? { brief } : {}),
	};
}

function sanitizeSynthesizerTransparency(value: unknown): StoredPackTurnTransparency["synthesizer"] | null {
	if (!isRecord(value)) return null;
	const status = sanitizeCardStatus(value.status);
	if (!status) return null;
	const elapsedMs = sanitizeOptionalNumber(value.elapsedMs);
	const claimCount = sanitizeOptionalNumber(value.claimCount);
	const summary = sanitizeOptionalString(value.summary);
	const rawJson = sanitizeOptionalClaims(value.rawJson);
	if (value.elapsedMs !== undefined && elapsedMs === undefined) return null;
	if (value.claimCount !== undefined && claimCount === undefined) return null;
	if (value.summary !== undefined && summary === undefined) return null;
	if (value.rawJson !== undefined && rawJson === undefined) return null;
	return {
		status,
		...(elapsedMs !== undefined ? { elapsedMs } : {}),
		...(claimCount !== undefined ? { claimCount } : {}),
		...(summary !== undefined ? { summary } : {}),
		...(rawJson !== undefined ? { rawJson } : {}),
	};
}

function sanitizeVerifierTransparency(value: unknown): StoredPackTurnTransparency["verifier"] | null {
	if (!isRecord(value)) return null;
	const status = sanitizeCardStatus(value.status);
	if (!status) return null;
	const elapsedMs = sanitizeOptionalNumber(value.elapsedMs);
	const counts = sanitizeOptionalVerifierCounts(value.counts);
	const reasons = sanitizeOptionalVerifierReasons(value.reasons);
	if (value.elapsedMs !== undefined && elapsedMs === undefined) return null;
	if (value.counts !== undefined && counts === undefined) return null;
	if (value.reasons !== undefined && reasons === undefined) return null;
	return {
		status,
		...(elapsedMs !== undefined ? { elapsedMs } : {}),
		...(counts !== undefined ? { counts } : {}),
		...(reasons !== undefined ? { reasons } : {}),
	};
}

function sanitizeRunTransparency(value: unknown): StoredPackTurnTransparency["run"] | null {
	if (!isRecord(value)) return null;
	const state = sanitizeRunState(value.state);
	const elapsedMs = sanitizeNumber(value.elapsedMs);
	const stepElapsedMs = sanitizeStepElapsedMs(value.stepElapsedMs);
	const failedStepId = sanitizeOptionalStepId(value.failedStepId);
	if (!state || elapsedMs === undefined || !stepElapsedMs) return null;
	if (value.failedStepId !== undefined && failedStepId === undefined) return null;
	return {
		state,
		elapsedMs,
		stepElapsedMs,
		...(failedStepId !== undefined ? { failedStepId } : {}),
	};
}

function sanitizeOptionalVerifierCounts(
	value: unknown,
): StoredPackTurnTransparency["verifier"]["counts"] | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) return undefined;
	const verified = sanitizeNumber(value.verified);
	const unsupported = sanitizeNumber(value.unsupported);
	const quoteMissing = sanitizeNumber(value.quoteMissing);
	if (verified === undefined || unsupported === undefined || quoteMissing === undefined) return undefined;
	return { verified, unsupported, quoteMissing };
}

function sanitizeOptionalVerifierReasons(
	value: unknown,
): StoredPackTurnTransparency["verifier"]["reasons"] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) return undefined;
	const reasons = value.map((reason) => {
		if (!isRecord(reason)) return null;
		const status = sanitizeClaimStatus(reason.status);
		if (
			typeof reason.claimId !== "string" ||
			typeof reason.claimText !== "string" ||
			typeof reason.sourceNote !== "string" ||
			typeof reason.explanation !== "string" ||
			!status
		) {
			return null;
		}
		return {
			claimId: reason.claimId,
			claimText: reason.claimText,
			sourceNote: reason.sourceNote,
			status,
			explanation: reason.explanation,
		};
	});
	return reasons.every((reason) => reason !== null) ? reasons : undefined;
}

function sanitizeOptionalClaims(value: unknown): StoredPackTurnTransparency["synthesizer"]["rawJson"] | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value) || typeof value.summary !== "string" || !Array.isArray(value.claims)) return undefined;
	const claims = value.claims.map((claim) => {
		if (
			!isRecord(claim) ||
			typeof claim.id !== "string" ||
			typeof claim.text !== "string" ||
			typeof claim.source_note !== "string" ||
			typeof claim.source_quote !== "string" ||
			typeof claim.confidence !== "number" ||
			!Number.isFinite(claim.confidence)
		) {
			return null;
		}
		return {
			id: claim.id,
			text: claim.text,
			source_note: claim.source_note,
			source_quote: claim.source_quote,
			confidence: claim.confidence,
		};
	});
	return claims.every((claim) => claim !== null)
		? {
			summary: value.summary,
			claims,
		}
		: undefined;
}

function sanitizeStepElapsedMs(value: unknown): StoredPackTurnTransparency["run"]["stepElapsedMs"] | null {
	if (!isRecord(value)) return null;
	const retriever = sanitizeOptionalNumber(value.retriever);
	const synthesizer = sanitizeOptionalNumber(value.synthesizer);
	const verifier = sanitizeOptionalNumber(value.verifier);
	if (value.retriever !== undefined && retriever === undefined) return null;
	if (value.synthesizer !== undefined && synthesizer === undefined) return null;
	if (value.verifier !== undefined && verifier === undefined) return null;
	return {
		...(retriever !== undefined ? { retriever } : {}),
		...(synthesizer !== undefined ? { synthesizer } : {}),
		...(verifier !== undefined ? { verifier } : {}),
	};
}

function sanitizeCardStatus(value: unknown): StoredPackTurnTransparency["retriever"]["status"] | null {
	return value === "pending" || value === "ready" || value === "absent" ? value : null;
}

function sanitizeRunState(value: unknown): StoredPackTurnTransparency["run"]["state"] | null {
	return value === "running" || value === "completed" || value === "failed" || value === "stopped" ? value : null;
}

function sanitizeClaimStatus(value: unknown): StoredClaimStatus | null {
	return value === "verified" || value === "unsupported" || value === "quote-missing" ? value : null;
}

function sanitizeOptionalStepId(value: unknown): StoredPackTurnTransparency["run"]["failedStepId"] | undefined {
	if (value === undefined) return undefined;
	return value === "retriever" || value === "synthesizer" || value === "verifier" ? value : undefined;
}

function sanitizeOptionalStringArray(value: unknown): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) return undefined;
	return value;
}

function sanitizeOptionalString(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	return typeof value === "string" ? value : undefined;
}

function sanitizeNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function sanitizeOptionalNumber(value: unknown): number | undefined {
	if (value === undefined) return undefined;
	return sanitizeNumber(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
