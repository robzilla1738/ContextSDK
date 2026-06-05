import { shellQuote } from "./shell.js";
import type { ContextFileEntry, ContextVersionChange } from "./types.js";

export function diffVersionFiles(previousFiles: ContextFileEntry[], currentFiles: ContextFileEntry[]): ContextVersionChange[] {
  const old = new Map(previousFiles.map(file => [file.path, file]));
  const current = new Map(currentFiles.map(file => [file.path, file]));
  const changes: ContextVersionChange[] = [];
  for (const path of [...current.keys()].sort()) {
    const before = old.get(path);
    const after = current.get(path);
    if (!before) {
      changes.push({ path, type: "added" });
    } else if (before.sha256 !== after?.sha256) {
      changes.push({ path, type: "modified" });
    }
  }
  for (const path of [...old.keys()].sort()) {
    if (!current.has(path)) {
      changes.push({ path, type: "removed" });
    }
  }
  return changes;
}

export function snapshotScript(options: {
  mountPath: string;
  generation: number;
  parentGeneration: number | null;
  author: string;
  message: string;
}): string {
  return [
    "set -Eeuo pipefail",
    `export CONTEXTSDK_MOUNT=${shellQuote(options.mountPath)}`,
    `export CONTEXTSDK_GENERATION=${shellQuote(String(options.generation))}`,
    `export CONTEXTSDK_PARENT=${shellQuote(options.parentGeneration === null ? "" : String(options.parentGeneration))}`,
    `export CONTEXTSDK_AUTHOR=${shellQuote(options.author)}`,
    `export CONTEXTSDK_MESSAGE=${shellQuote(options.message)}`,
    "python3 - <<'PY'",
    "import hashlib, json, os, pathlib, stat, time",
    "mount = pathlib.Path(os.environ['CONTEXTSDK_MOUNT'])",
    "meta = mount / '.contextsdk'",
    "versions = meta / 'versions'",
    "versions.mkdir(parents=True, exist_ok=True)",
    "roots = ['workspace', 'memory', 'artifacts', 'logs', 'cache', 'config']",
    "files = []",
    "for root_name in roots:",
    "    root = mount / root_name",
    "    if not root.exists():",
    "        continue",
    "    for path in sorted(root.rglob('*')):",
    "        if not path.is_file():",
    "            continue",
    "        rel = path.relative_to(mount).as_posix()",
    "        data = path.read_bytes()",
    "        st = path.stat()",
    "        files.append({'path': rel, 'size': st.st_size, 'mode': oct(stat.S_IMODE(st.st_mode)), 'mtime': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(st.st_mtime)), 'sha256': hashlib.sha256(data).hexdigest()})",
    "index_path = meta / 'index.json'",
    "previous_files = []",
    "if index_path.exists():",
    "    try:",
    "        previous_files = json.loads(index_path.read_text()).get('files', [])",
    "    except Exception:",
    "        previous_files = []",
    "old = {f['path']: f for f in previous_files}",
    "new = {f['path']: f for f in files}",
    "changes = []",
    "for path in sorted(new):",
    "    if path not in old:",
    "        changes.append({'path': path, 'type': 'added'})",
    "    elif old[path].get('sha256') != new[path].get('sha256'):",
    "        changes.append({'path': path, 'type': 'modified'})",
    "for path in sorted(old):",
    "    if path not in new:",
    "        changes.append({'path': path, 'type': 'removed'})",
    "generation = int(os.environ['CONTEXTSDK_GENERATION'])",
    "parent_raw = os.environ.get('CONTEXTSDK_PARENT') or None",
    "record = {'version': 1, 'generation': generation, 'parentGeneration': int(parent_raw) if parent_raw else None, 'timestamp': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'author': os.environ['CONTEXTSDK_AUTHOR'], 'message': os.environ['CONTEXTSDK_MESSAGE'], 'changedPaths': changes, 'files': files}",
    "(versions / f'{generation}.json').write_text(json.dumps(record, indent=2, sort_keys=True) + '\\n')",
    "index_path.write_text(json.dumps(record, indent=2, sort_keys=True) + '\\n')",
    "print('CONTEXTSDK_VERSION_JSON=' + json.dumps(record, sort_keys=True))",
    "PY",
  ].join("\n");
}
