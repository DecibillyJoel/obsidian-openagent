import { describe, expect, it, vi } from "vitest";
import { ChatView } from "../src/view";

interface FakeRange {
	commonAncestorContainer: unknown;
	cloneContents: () => unknown;
}

interface FakeSelection {
	rangeCount: number;
	isCollapsed: boolean;
	getRangeAt: () => FakeRange;
}

interface HarnessOptions {
	selection: FakeSelection | null;
	contained: boolean;
	innerHTML: string;
	clipboardAvailable: boolean;
}

interface Harness {
	setData: ReturnType<typeof vi.fn>;
	preventDefault: ReturnType<typeof vi.fn>;
	dispatch: () => void;
}

const elementRange: FakeRange = {
	commonAncestorContainer: { nodeType: 1 },
	cloneContents: () => ({}),
};

const textRange: FakeRange = {
	commonAncestorContainer: { nodeType: 3, parentElement: { nodeType: 1 } },
	cloneContents: () => ({}),
};

function selection(overrides: Partial<FakeSelection> = {}): FakeSelection {
	return {
		rangeCount: 1,
		isCollapsed: false,
		getRangeAt: () => elementRange,
		...overrides,
	};
}

function createHarness(options: HarnessOptions): Harness {
	const container = { innerHTML: options.innerHTML, appendChild: vi.fn() };
	const transcriptEl = {
		ownerDocument: {
			getSelection: () => options.selection,
			createElement: () => container,
		},
		contains: () => options.contained,
	};
	const view = new ChatView({} as never, {} as never);
	(view as unknown as { transcriptEl: unknown }).transcriptEl = transcriptEl;

	const setData = vi.fn();
	const preventDefault = vi.fn();
	const event = {
		clipboardData: options.clipboardAvailable ? { setData } : null,
		preventDefault,
	} as unknown as ClipboardEvent;

	return { setData, preventDefault, dispatch: () => view.handleTranscriptCopy(event) };
}

describe("ChatView.handleTranscriptCopy", () => {
	it("does nothing without a selection", () => {
		const harness = createHarness({
			selection: null,
			contained: true,
			innerHTML: "<p>Hello</p>",
			clipboardAvailable: true,
		});
		harness.dispatch();
		expect(harness.setData).not.toHaveBeenCalled();
		expect(harness.preventDefault).not.toHaveBeenCalled();
	});

	it("does nothing for an empty range list", () => {
		const harness = createHarness({
			selection: selection({ rangeCount: 0 }),
			contained: true,
			innerHTML: "<p>Hello</p>",
			clipboardAvailable: true,
		});
		harness.dispatch();
		expect(harness.setData).not.toHaveBeenCalled();
	});

	it("does nothing for a collapsed selection", () => {
		const harness = createHarness({
			selection: selection({ isCollapsed: true }),
			contained: true,
			innerHTML: "<p>Hello</p>",
			clipboardAvailable: true,
		});
		harness.dispatch();
		expect(harness.setData).not.toHaveBeenCalled();
	});

	it("does nothing when the clipboard is unavailable", () => {
		const harness = createHarness({
			selection: selection(),
			contained: true,
			innerHTML: "<p>Hello</p>",
			clipboardAvailable: false,
		});
		harness.dispatch();
		expect(harness.setData).not.toHaveBeenCalled();
	});

	it("does nothing when the selection is outside the transcript", () => {
		const harness = createHarness({
			selection: selection(),
			contained: false,
			innerHTML: "<p>Hello</p>",
			clipboardAvailable: true,
		});
		harness.dispatch();
		expect(harness.setData).not.toHaveBeenCalled();
		expect(harness.preventDefault).not.toHaveBeenCalled();
	});

	it("keeps the default copy behaviour when the conversion is empty", () => {
		const harness = createHarness({
			selection: selection(),
			contained: true,
			innerHTML: "",
			clipboardAvailable: true,
		});
		harness.dispatch();
		expect(harness.setData).not.toHaveBeenCalled();
		expect(harness.preventDefault).not.toHaveBeenCalled();
	});

	it("writes markdown to the clipboard for a transcript selection", () => {
		const harness = createHarness({
			selection: selection(),
			contained: true,
			innerHTML: "<p>Hello</p>",
			clipboardAvailable: true,
		});
		harness.dispatch();
		expect(harness.setData).toHaveBeenCalledWith("text/plain", "<p>Hello</p>");
		expect(harness.setData).toHaveBeenCalledWith("text/html", "<p>Hello</p>");
		expect(harness.preventDefault).toHaveBeenCalled();
	});

	it("accepts a selection whose ancestor is a text node", () => {
		const harness = createHarness({
			selection: selection({ getRangeAt: () => textRange }),
			contained: true,
			innerHTML: "<p>Hello</p>",
			clipboardAvailable: true,
		});
		harness.dispatch();
		expect(harness.setData).toHaveBeenCalledWith("text/plain", "<p>Hello</p>");
		expect(harness.preventDefault).toHaveBeenCalled();
	});
});
