import path from "node:path";

export function taskDir(dataDir: string, taskId: string): string {
  return path.join(dataDir, "tasks", taskId);
}

export function sourcePath(dir: string, ext: string): string {
  return path.join(dir, `source${ext}`);
}

export function audioPath(dir: string): string {
  return path.join(dir, "audio.mp3");
}

export function transcriptPath(dir: string): string {
  return path.join(dir, "transcript.json");
}
