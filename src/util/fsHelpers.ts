

export function getDirectoryPathFromFilePath(filePath: string) {
  const pathParts = filePath.split('/');
  pathParts.pop();
  return pathParts.join('/');
}