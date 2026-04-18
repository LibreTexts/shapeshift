import { Environment } from '../lib/environment';

export function getDirectoryPathFromFilePath(filePath: string) {
  const pathParts = filePath.split('/');
  pathParts.pop();
  return pathParts.join('/');
}

export function fsPathToS3Key(filePath: string): string {
  const baseDir = Environment.getOptional('TMP_OUT_DIR', './.tmp');
  const split = filePath.split(baseDir.replace('./', '/'));
  const out = split[split.length - 1];
  return out.startsWith('/') ? out.slice(1) : out;
}
