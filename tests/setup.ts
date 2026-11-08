import { beforeEach, vi } from "vitest";

export class MockTFile {
	path: string;
	basename: string;
	extension: string;

	constructor(path: string) {
		this.path = path;
		const parts = path.split("/");
		const fileName = parts[parts.length - 1] ?? path;
		const match = fileName.match(/^(.*?)(?:\.([^.]+))?$/);
		this.basename = match?.[1] ?? fileName;
		this.extension = match?.[2] ?? "md";
	}
}

export class MockClassList {
	private readonly values = new Set<string>();

	add(...classes: string[]): void {
		for (const value of classes) {
			for (const name of value.split(/\s+/).filter(Boolean)) this.values.add(name);
		}
	}

	remove(...classes: string[]): void {
		for (const value of classes) {
			for (const name of value.split(/\s+/).filter(Boolean)) this.values.delete(name);
		}
	}

	toggle(name: string, force?: boolean): boolean {
		if (force === true) {
			this.values.add(name);
			return true;
		}
		if (force === false) {
			this.values.delete(name);
			return false;
		}
		if (this.values.has(name)) {
			this.values.delete(name);
			return false;
		}
		this.values.add(name);
		return true;
	}

	contains(name: string): boolean {
		return this.values.has(name);
	}

	toString(): string {
		return [...this.values].join(" ");
	}
}

type MockListener = (event: { preventDefault(): void; target: MockElement }) => void;

export class MockElement {
	tagName: string;
	textContent = "";
	value = "";
	parentElement: MockElement | null = null;
	children: MockElement[] = [];
	classList = new MockClassList();
	private readonly listeners = new Map<string, MockListener[]>();

	constructor(tagName = "div", options?: { cls?: string; text?: string; attr?: Record<string, string> }) {
		this.tagName = tagName;
		if (options?.cls) this.classList.add(options.cls);
		if (options?.text) this.textContent = options.text;
		if (options?.attr) {
			for (const [name, value] of Object.entries(options.attr)) this.setAttribute(name, value);
		}
	}

	createDiv(options?: { cls?: string; text?: string; attr?: Record<string, string> }): MockElement {
		return this.createEl("div", options);
	}

	createEl(tagName: string, options?: { cls?: string; text?: string; attr?: Record<string, string> }): MockElement {
		const child = new MockElement(tagName, options);
		child.parentElement = this;
		this.children.push(child);
		return child;
	}

	empty(): void {
		this.children = [];
		this.textContent = "";
	}

	addClass(name: string): void {
		this.classList.add(name);
	}

	removeClass(name: string): void {
		this.classList.remove(name);
	}

	setText(text: string): void {
		this.textContent = text;
	}

	appendText(text: string): void {
		this.textContent += text;
	}

	setAttribute(name: string, value: string): void {
		if (name === "value") this.value = value;
	}

	addEventListener(type: string, listener: MockListener): void {
		const listeners = this.listeners.get(type) ?? [];
		listeners.push(listener);
		this.listeners.set(type, listeners);
	}

	click(): void {
		for (const listener of this.listeners.get("click") ?? []) {
			listener({ preventDefault() {}, target: this });
		}
	}

	focus(): void {}

	select(): void {}
}

export interface MockFileCache {
	tags?: Array<{ tag: string }>;
	frontmatter?: { tags?: string | string[] };
}

export interface MockAdapter {
	exists: ReturnType<typeof vi.fn>;
	mkdir: ReturnType<typeof vi.fn>;
	list: ReturnType<typeof vi.fn>;
	read: ReturnType<typeof vi.fn>;
	write: ReturnType<typeof vi.fn>;
	remove: ReturnType<typeof vi.fn>;
	rename: ReturnType<typeof vi.fn>;
}

export interface MockVaultState {
	files: Map<string, string>;
	fileCaches: Map<string, MockFileCache>;
	resolvedLinks: Record<string, Record<string, number>>;
}

export function createMockAdapter(initialFiles: Record<string, string> = {}): MockAdapter {
	const files = new Map(Object.entries(initialFiles));
	const hasPath = (path: string) =>
		files.has(path) || [...files.keys()].some((file) => file.startsWith(path.endsWith("/") ? path : `${path}/`));
	return {
		exists: vi.fn(async (path: string) => hasPath(path)),
		mkdir: vi.fn(async () => undefined),
		list: vi.fn(async (dir: string) => ({
			files: [...files.keys()].filter((file) => file.startsWith(`${dir}/`)).sort(),
		})),
		read: vi.fn(async (path: string) => {
			if (!files.has(path)) throw new Error(`Missing file: ${path}`);
			return files.get(path);
		}),
		write: vi.fn(async (path: string, text: string) => {
			files.set(path, text);
		}),
		remove: vi.fn(async (path: string) => {
			files.delete(path);
		}),
		rename: vi.fn(async (from: string, to: string) => {
			if (!files.has(from)) throw new Error(`Missing file: ${from}`);
			files.set(to, files.get(from) ?? "");
			files.delete(from);
		}),
	};
}

export function createMockApp(options?: {
	files?: Record<string, string>;
	fileCaches?: Record<string, MockFileCache>;
	resolvedLinks?: Record<string, Record<string, number>>;
}) {
	const fileMap = new Map(Object.entries(options?.files ?? {}));
	const fileCaches = new Map(Object.entries(options?.fileCaches ?? {}));
	const resolvedLinks = options?.resolvedLinks ?? {};
	const markdownFiles = () => [...fileMap.keys()].filter((path) => path.endsWith(".md")).map((path) => new MockTFile(path));

	return {
		vault: {
			adapter: createMockAdapter(options?.files),
			getMarkdownFiles: vi.fn(() => markdownFiles()),
			getAbstractFileByPath: vi.fn((path: string) => (fileMap.has(path) ? new MockTFile(path) : null)),
			cachedRead: vi.fn(async (file: { path: string }) => {
				if (!fileMap.has(file.path)) throw new Error(`Missing file: ${file.path}`);
				return fileMap.get(file.path) ?? "";
			}),
		},
		metadataCache: {
			resolvedLinks,
			getFirstLinkpathDest: vi.fn((linkpath: string) => {
				const direct = [...fileMap.keys()].find((path) => path === linkpath || path === `${linkpath}.md` || path.endsWith(`/${linkpath}.md`));
				return direct ? new MockTFile(direct) : null;
			}),
			getFileCache: vi.fn((file: { path: string }) => fileCaches.get(file.path) ?? null),
		},
		workspace: {
			getActiveFile: vi.fn(() => null),
			getLeaf: vi.fn(() => ({ openFile: vi.fn(async () => undefined) })),
		},
	};
}

export const requestUrlMock = vi.fn(async () => ({ status: 200, json: { data: [] } }));

export const NoticeMock = vi.fn(function Notice(this: { message: string }, message: string) {
	this.message = message;
});

export const Platform = {
	isMobileApp: false,
	isDesktopApp: true,
	isMobile: false,
};

export class MockWorkspaceLeaf {
	app: unknown;

	constructor(app?: unknown) {
		this.app = app ?? null;
	}

	openFile = vi.fn(async () => undefined);
}

export class MockItemView {
	app: unknown;
	contentEl: MockElement;

	constructor(leaf: { app?: unknown }) {
		this.app = leaf?.app ?? null;
		this.contentEl = new MockElement("div");
	}
}

export class MockModal {
	app: unknown;
	contentEl: MockElement;

	constructor(app: unknown) {
		this.app = app;
		this.contentEl = new MockElement("div");
	}

	open(): void {}

	close(): void {}
}

export const MarkdownRendererMock = {
	render: vi.fn(async (_app: unknown, markdown: string, el: { appendText?: (text: string) => void; createEl?: (tag: string, options?: { text?: string }) => unknown }) => {
		if (typeof el.appendText === "function") {
			el.appendText(markdown);
			return;
		}
		if (typeof el.createEl === "function") {
			el.createEl("span", { text: markdown });
		}
	}),
};

export const htmlToMarkdownMock = (html: string | { innerHTML?: string }): string =>
	typeof html === "string" ? html : html.innerHTML ?? "";

class MockPluginSettingTab {
	app: unknown;
	plugin: unknown;
	containerEl: MockElement;

	constructor(app: unknown, plugin: unknown) {
		this.app = app;
		this.plugin = plugin;
		this.containerEl = new MockElement("div");
	}
}

class MockSetting {
	constructor(_containerEl: unknown) {}

	setName(_value: string): this {
		return this;
	}

	setDesc(_value: string): this {
		return this;
	}

	setHeading(): this {
		return this;
	}

	addDropdown(cb: (drop: { addOption(value: string, label: string): typeof drop; setValue(value: string): typeof drop; onChange(handler: (value: string) => void): typeof drop }) => void): this {
		const drop = {
			addOption() {
				return drop;
			},
			setValue() {
				return drop;
			},
			onChange() {
				return drop;
			},
		};
		cb(drop);
		return this;
	}

	addText(cb: (txt: {
		setPlaceholder(value: string): typeof txt;
		setValue(value: string): typeof txt;
		onChange(handler: (value: string) => void): typeof txt;
		inputEl: { type: string; autocomplete: string };
	}) => void): this {
		const txt = {
			setPlaceholder() {
				return txt;
			},
			setValue() {
				return txt;
			},
			onChange() {
				return txt;
			},
			inputEl: { type: "text", autocomplete: "" },
		};
		cb(txt);
		return this;
	}

	addTextArea(cb: (txt: {
		setPlaceholder(value: string): typeof txt;
		setValue(value: string): typeof txt;
		onChange(handler: (value: string) => void): typeof txt;
	}) => void): this {
		const txt = {
			setPlaceholder() {
				return txt;
			},
			setValue() {
				return txt;
			},
			onChange() {
				return txt;
			},
		};
		cb(txt);
		return this;
	}
}

vi.mock("obsidian", () => ({
	App: class App {},
	Platform,
	Plugin: class Plugin {},
	PluginSettingTab: MockPluginSettingTab,
	Setting: MockSetting,
	ItemView: MockItemView,
	Modal: MockModal,
	MarkdownRenderer: MarkdownRendererMock,
	htmlToMarkdown: htmlToMarkdownMock,
	Notice: NoticeMock,
	TFile: MockTFile,
	WorkspaceLeaf: MockWorkspaceLeaf,
	requestUrl: requestUrlMock,
}));

export function setMobileMode(isMobile: boolean): void {
	Platform.isMobileApp = isMobile;
	Platform.isDesktopApp = !isMobile;
	Platform.isMobile = isMobile;
}

beforeEach(() => {
	setMobileMode(false);
	requestUrlMock.mockClear();
	NoticeMock.mockClear();
});
