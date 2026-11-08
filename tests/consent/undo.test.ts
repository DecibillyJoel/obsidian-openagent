import { describe, expect, it } from "vitest";
import { UndoBuffer, type CreateFolderOp, type MoveOp, type TrashMoveOp } from "../../src/consent/undo";

describe("UndoBuffer record kinds", () => {
	it("records a text write as an unkinded write op", () => {
		const buffer = new UndoBuffer();
		const op = buffer.record({ path: "notes/a.md", before: null, after: "hello" });
		expect(op.path).toBe("notes/a.md");
		expect(op.before).toBeNull();
		expect(op.after).toBe("hello");
		expect("kind" in op).toBe(false);
		expect(buffer.size()).toBe(1);
	});

	it("records a rename as a move op and pops it back", () => {
		const buffer = new UndoBuffer();
		buffer.record({ kind: "move", from: "Notes/old.md", to: "Notes/new.md", itemType: "file" });
		const op = buffer.pop() as MoveOp;
		expect(op.kind).toBe("move");
		expect(op.from).toBe("Notes/old.md");
		expect(op.to).toBe("Notes/new.md");
		expect(op.itemType).toBe("file");
		expect(buffer.size()).toBe(0);
	});

	it("records a folder move with folder item type", () => {
		const buffer = new UndoBuffer();
		buffer.record({ kind: "move", from: "Characters/Villains", to: "Archive/Villains", itemType: "folder" });
		const op = buffer.peek() as MoveOp;
		expect(op.kind).toBe("move");
		expect(op.itemType).toBe("folder");
		expect(buffer.size()).toBe(1);
	});

	it("records a delete as a trash-move op with its trash path", () => {
		const buffer = new UndoBuffer();
		buffer.record({
			kind: "trash-move",
			from: "note.md",
			to: ".trash/note-20260830T140000000Z.md",
			itemType: "file",
		});
		const op = buffer.pop() as TrashMoveOp;
		expect(op.kind).toBe("trash-move");
		expect(op.from).toBe("note.md");
		expect(op.to).toBe(".trash/note-20260830T140000000Z.md");
		expect(op.itemType).toBe("file");
	});

	it("records folder creation with the list of created paths", () => {
		const buffer = new UndoBuffer();
		buffer.record({
			kind: "create-folder",
			path: "Characters/Villains",
			createdPaths: ["Characters", "Characters/Villains"],
		});
		const op = buffer.pop() as CreateFolderOp;
		expect(op.kind).toBe("create-folder");
		expect(op.path).toBe("Characters/Villains");
		expect(op.createdPaths).toEqual(["Characters", "Characters/Villains"]);
	});

	it("assigns a unique id and a timestamp to every record", () => {
		const buffer = new UndoBuffer();
		const first = buffer.record({ path: "a.md", before: null, after: "a" });
		const second = buffer.record({ kind: "move", from: "a.md", to: "b.md", itemType: "file" });
		expect(first.id).not.toBe(second.id);
		expect(second.timestamp).toBeGreaterThan(0);
	});

	it("keeps only the most recent ops up to capacity", () => {
		const buffer = new UndoBuffer(2);
		buffer.record({ path: "a.md", before: null, after: "a" });
		buffer.record({ path: "b.md", before: null, after: "b" });
		buffer.record({ path: "c.md", before: null, after: "c" });
		expect(buffer.size()).toBe(2);
		const top = buffer.peek();
		expect(top && "path" in top ? top.path : undefined).toBe("c.md");
	});

	it("clears every recorded op", () => {
		const buffer = new UndoBuffer();
		buffer.record({ path: "a.md", before: "old", after: "new" });
		buffer.record({ kind: "move", from: "a.md", to: "b.md", itemType: "file" });
		buffer.clear();
		expect(buffer.size()).toBe(0);
		expect(buffer.pop()).toBeUndefined();
	});
});
