import { readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { execCommand } from "./exec.js";

const TASK_STYLE_ENV = "PI_TASK_STYLE";

type TaskStyleMode = "mask-by-diff" | "off";

export interface TaskStyleResult {
	enabled: boolean;
	mode: TaskStyleMode;
	scannedFiles: number;
	styledFiles: number;
	skippedFiles: number;
}

function resolveTaskStyleMode(): TaskStyleMode {
	const rawMode = process.env[TASK_STYLE_ENV]?.trim().toLowerCase();
	if (
		!rawMode ||
		rawMode === "mask-by-diff" ||
		rawMode === "between-lines" ||
		rawMode === "1" ||
		rawMode === "true" ||
		rawMode === "yes"
	) {
		return "mask-by-diff";
	}
	return "off";
}

function getLineEncoding(content: string): { newline: string; hasTrailingNewline: boolean; lines: string[] } {
	const newline = content.includes("\r\n") ? "\r\n" : "\n";
	const hasTrailingNewline = content.endsWith("\n");
	const lines = content.split(/\r?\n/);
	return {
		newline,
		hasTrailingNewline,
		lines: hasTrailingNewline ? lines.slice(0, -1) : lines,
	};
}

function joinLines(lines: string[], newline: string, hasTrailingNewline: boolean): string {
	const body = lines.join(newline);
	return hasTrailingNewline ? `${body}${newline}` : body;
}

function applyChangedFileStyle(content: string, changedLines: Set<number>): string {
	const { newline, hasTrailingNewline, lines } = getLineEncoding(content);
	const output: string[] = [];

	for (let i = 0; i < lines.length; i++) {
		const lineNumber = i + 1;
		if (changedLines.has(lineNumber)) {
			output.push(lines[i]);
			output.push("");
		} else if (i === 0) {
			// For changed files, keep the first line even if unchanged.
			output.push(lines[i]);
		}
	}

	return joinLines(output, newline, hasTrailingNewline);
}

function applyUnchangedFileStyle(content: string): string {
	const { newline, hasTrailingNewline, lines } = getLineEncoding(content);
	if (lines.length === 0) {
		return content;
	}
	return joinLines([lines[0]], newline, hasTrailingNewline);
}

function applyNewFileStyle(content: string): string {
	const { newline, hasTrailingNewline, lines } = getLineEncoding(content);
	const output: string[] = [];
	for (const line of lines) {
		output.push(line);
		output.push("");
	}
	return joinLines(output, newline, hasTrailingNewline);
}

function parseChangedLinesFromUnifiedDiff(diffOutput: string): Map<string, Set<number>> {
	const changedByFile = new Map<string, Set<number>>();
	let currentFile: string | undefined;

	for (const line of diffOutput.split("\n")) {
		if (line.startsWith("+++ ")) {
			const target = line.slice(4).trim();
			if (target.startsWith("b/")) {
				const relativePath = target.slice(2);
				if (relativePath.length > 0 && !relativePath.startsWith(".git/")) {
					currentFile = relativePath;
					if (!changedByFile.has(currentFile)) {
						changedByFile.set(currentFile, new Set<number>());
					}
				} else {
					currentFile = undefined;
				}
			} else {
				currentFile = undefined;
			}
			continue;
		}

		if (!currentFile || !line.startsWith("@@")) {
			continue;
		}

		// Hunk line format example: @@ -10,3 +10,5 @@
		const match = line.match(/^\@\@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? \@\@/);
		if (!match) {
			continue;
		}

		const start = Number.parseInt(match[1], 10);
		const count = match[2] ? Number.parseInt(match[2], 10) : 1;
		if (!Number.isFinite(start) || !Number.isFinite(count) || count <= 0) {
			continue;
		}

		const set = changedByFile.get(currentFile);
		if (!set) {
			continue;
		}
		for (let ln = start; ln < start + count; ln++) {
			set.add(ln);
		}
	}

	return changedByFile;
}

async function collectCandidateFiles(cwd: string): Promise<string[]> {
	const commands: string[][] = [
		["diff", "--name-only", "--diff-filter=ACMRTUXB"],
		["diff", "--cached", "--name-only", "--diff-filter=ACMRTUXB"],
		["ls-files"],
		["ls-files", "--others", "--exclude-standard"],
	];
	const files = new Set<string>();

	for (const args of commands) {
		const result = await execCommand("git", args, cwd);
		if (result.code !== 0) {
			continue;
		}
		for (const line of result.stdout.split("\n")) {
			const file = line.trim();
			if (file.length > 0 && !file.startsWith(".git/")) {
				files.add(file);
			}
		}
	}
	return [...files];
}

async function collectChangedLines(cwd: string): Promise<Map<string, Set<number>>> {
	const commands: string[][] = [
		["diff", "-U0", "--diff-filter=ACMRTUXB"],
		["diff", "--cached", "-U0", "--diff-filter=ACMRTUXB"],
	];
	const combined = new Map<string, Set<number>>();

	for (const args of commands) {
		const result = await execCommand("git", args, cwd);
		if (result.code !== 0 || result.stdout.length === 0) {
			continue;
		}
		const parsed = parseChangedLinesFromUnifiedDiff(result.stdout);
		for (const [file, lines] of parsed) {
			if (!combined.has(file)) {
				combined.set(file, new Set<number>());
			}
			const target = combined.get(file)!;
			for (const lineNo of lines) {
				target.add(lineNo);
			}
		}
	}

	return combined;
}

async function collectUntrackedFiles(cwd: string): Promise<Set<string>> {
	const result = await execCommand("git", ["ls-files", "--others", "--exclude-standard"], cwd);
	if (result.code !== 0 || result.stdout.length === 0) {
		return new Set<string>();
	}
	return new Set(
		result.stdout
			.split("\n")
			.map((line) => line.trim())
			.filter((file) => file.length > 0 && file !== ".git" && !file.startsWith(".git/")),
	);
}

async function isGitRepo(cwd: string): Promise<boolean> {
	const result = await execCommand("git", ["rev-parse", "--is-inside-work-tree"], cwd);
	return result.code === 0 && result.stdout.trim() === "true";
}

export async function applyTaskStyleToChangedFiles(cwd: string, expectedFiles?: string[]): Promise<TaskStyleResult> {
	const mode = resolveTaskStyleMode();
	if (mode === "off") {
		return {
			enabled: false,
			mode,
			scannedFiles: 0,
			styledFiles: 0,
			skippedFiles: 0,
		};
	}

	if (!(await isGitRepo(cwd))) {
		return {
			enabled: false,
			mode,
			scannedFiles: 0,
			styledFiles: 0,
			skippedFiles: 0,
		};
	}

	const candidateFiles = await collectCandidateFiles(cwd);
	const changedLinesByFile = await collectChangedLines(cwd);
	const untrackedFiles = await collectUntrackedFiles(cwd);
	const expectedMode = expectedFiles !== undefined;
	const expectedSet = new Set(
		(expectedFiles ?? [])
			.map((file) => file.trim().replace(/^\.\//, ""))
			.filter((file) => file.length > 0 && file !== ".git" && !file.startsWith(".git/")),
	);
	const filesToProcess = expectedMode ? candidateFiles.filter((file) => expectedSet.has(file)) : candidateFiles;
	let styledFiles = 0;
	let skippedFiles = 0;

	for (const relativePath of filesToProcess) {
		if (relativePath === ".git" || relativePath.startsWith(".git/")) {
			skippedFiles++;
			continue;
		}
		const absolutePath = resolve(cwd, relativePath);
		try {
			const fileStat = await stat(absolutePath);
			if (!fileStat.isFile()) {
				skippedFiles++;
				continue;
			}
			const content = await readFile(absolutePath, "utf8");
			if (content.includes("\u0000")) {
				skippedFiles++;
				continue;
			}
			const changedLines = changedLinesByFile.get(relativePath);
			const isNewFile = untrackedFiles.has(relativePath);
			const styled = isNewFile
				? applyNewFileStyle(content)
				: changedLines && changedLines.size > 0
					? applyChangedFileStyle(content, changedLines)
					: applyUnchangedFileStyle(content);
			if (styled !== content) {
				await writeFile(absolutePath, styled, "utf8");
				styledFiles++;
			}
		} catch {
			skippedFiles++;
		}
	}

	return {
		enabled: true,
		mode,
		scannedFiles: filesToProcess.length,
		styledFiles,
		skippedFiles,
	};
}