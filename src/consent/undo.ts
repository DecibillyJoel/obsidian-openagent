export interface WriteOp {
	id: string;
	path: string;
	before: string | null; // null = file didn't exist before
	after: string;
	timestamp: number;
}

export interface MoveOp {
	id: string;
	kind: "move";
	from: string;
	to: string;
	itemType: "file" | "folder";
	timestamp: number;
}

export interface TrashMoveOp {
	id: string;
	kind: "trash-move";
	from: string;
	to: string;
	itemType: "file" | "folder";
	timestamp: number;
}

export interface CreateFolderOp {
	id: string;
	kind: "create-folder";
	path: string;
	createdPaths: string[];
	timestamp: number;
}

export type UndoOp = WriteOp | MoveOp | TrashMoveOp | CreateFolderOp;

export type UndoRecordInput =
	| Omit<WriteOp, "id" | "timestamp">
	| Omit<MoveOp, "id" | "timestamp">
	| Omit<TrashMoveOp, "id" | "timestamp">
	| Omit<CreateFolderOp, "id" | "timestamp">;

export class UndoBuffer {
	private readonly capacity: number;
	private ops: UndoOp[] = [];

	constructor(capacity = 50) {
		this.capacity = capacity;
	}

	record(op: UndoRecordInput): UndoOp {
		const full = {
			id: crypto.randomUUID(),
			timestamp: Date.now(),
			...op,
		} as UndoOp;
		this.ops.push(full);
		if (this.ops.length > this.capacity) this.ops.shift();
		return full;
	}

	pop(): UndoOp | undefined {
		return this.ops.pop();
	}

	peek(): UndoOp | undefined {
		return this.ops[this.ops.length - 1];
	}

	size(): number {
		return this.ops.length;
	}

	clear(): void {
		this.ops = [];
	}
}
