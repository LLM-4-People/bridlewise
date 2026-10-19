/**
 * THE SECRET-FILE OWNER (cred-final §11, CRED-F11 part 1; coordinator
 * decision 2026-09-28): a file whose NAME says it holds credentials — an env
 * file, a private key, a registry or netrc credential file — is shown to a
 * model with every VALUE redacted and its KEYS and structure visible, so the
 * model can still say which settings exist and edit around them, and no value
 * leaves through a read. A value no detector recognises (a random token under
 * an ordinary name, a connection string) is hidden too: the file's name, not
 * the value's shape, is the evidence.
 *
 * Asked by every path that hands file text to a model: the engine's file
 * viewer (its `read_file`) and the web server's `read_file` and `search_code`.
 * A user's own editor read is NOT a model read and stays exact (it writes the
 * file back).
 */
import { ROOT_POLICY } from "../kernel/root-policy.ts";
import { redactionReplacement, type PrivacyPolicy } from "./privacy-policy.ts";

/** Names that hold credentials (compared lower-case), beyond the safety floor's own store files (below). */
const SECRET_FILE_NAMES: ReadonlySet<string> = new Set([
  ".env", ".envrc", ".yarnrc.yml", "_netrc", ".htpasswd", ".dockercfg", "credentials", "credentials.json", "credentials.toml",
  "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", "id_ecdsa_sk", "id_ed25519_sk", "kubeconfig",
  "secrets.json", "secrets.yml", "secrets.yaml", "secrets.toml", "terraform.tfvars",
]);

/**
 * THE CREDENTIAL FILES OF THE STORES THE SAFETY FLOOR NAMES
 * (`ROOT_POLICY.selfProtection.minimumRefusedPaths`, one catalog): in a home
 * they are refused outright; the same names committed INSIDE a project are
 * project content, read with their values hidden. Every floor entry is a
 * path suffix here (`.npmrc`, `.git-credentials`, `.config/containers/auth.json`,
 * `.m2/settings.xml`…), plus the credential file inside a floor store FOLDER
 * whose other files are ordinary configuration (`.docker/config.json`, not
 * `.docker/compose.yml`; `.codex/auth.json`, not `.codex/config.toml`).
 */
const STORE_CREDENTIAL_FILES: readonly (readonly string[])[] = Object.freeze([
  ...ROOT_POLICY.selfProtection.minimumRefusedPaths.filter((entry) => !entry.endsWith("*")).map((entry) => entry.slice(2).toLowerCase().split("/")),
  ...[".docker/config.json", ".kube/config", ".config/gh/hosts.yml", ".codex/auth.json", ".claude/.credentials.json", ".gemini/oauth_creds.json",
    ".config/rclone/rclone.conf", ".terraform.d/credentials.tfrc.json", ".azure/accesstokens.json", ".azure/msal_token_cache.json"].map((entry) => entry.split("/")),
]);
/** Extensions of key material and credential stores. */
const SECRET_FILE_EXTENSIONS: readonly string[] = Object.freeze([".pem", ".key", ".p12", ".pfx", ".jks", ".keystore", ".ppk", ".tfvars", ".env"]);
/** `.env.<stage>` holds values; its documented templates do not. */
const ENV_TEMPLATE_SUFFIXES: ReadonlySet<string> = new Set(["example", "sample", "template", "dist", "defaults"]);

/** Whether `path`'s file name (or its place in a credential store's layout) says it holds credentials. */
export function isSecretFile(path: string): boolean {
  const segments = path.split(/[\\/]/u).filter((segment) => segment.length > 0).map((segment) => segment.toLowerCase());
  const name = segments.at(-1) ?? "";
  if (SECRET_FILE_NAMES.has(name)) return true;
  if (STORE_CREDENTIAL_FILES.some((suffix) => suffix.length <= segments.length && suffix.every((part, index) => part === segments[segments.length - suffix.length + index]))) return true;
  if (name.startsWith(".env.")) return !ENV_TEMPLATE_SUFFIXES.has(name.slice(5));
  return SECRET_FILE_EXTENSIONS.some((extension) => name.endsWith(extension) && name.length > extension.length);
}

const PEM_BEGIN = /^\s*-----BEGIN [A-Z0-9 ]+-----\s*$/u;
const PEM_END = /^\s*-----END [A-Z0-9 ]+-----\s*$/u;
/**
 * A KEY a secret file may show: quoted (`"auth"`, `'x'`), or a bare
 * identifier-shaped name (`API_TOKEN`, `client-key-data`, `@scope`, `- name`),
 * never free text — a token followed by `=` or `:` is not a key.
 */
const KEY = String.raw`(?:export\s+)?(?:-\s+)?(?:"[^"]*"|'[^']*'|[A-Za-z_@$][\w.\-/@$]{0,63})`;
/** A comment: its marker is kept, its body is read like any other line (a commented-out `TOKEN=…` is a value too). */
const COMMENT = /^(\s*(?:#|;|\/\/(?=\s|$))\s*)(.*)$/u;
/** A section header (`[name]`, `[[name]]`, `[name "argument"]`): its name is shown, an argument only when it is plain words. */
const SECTION = /^(\s*\[\[?)([^\]]*?)(\]\]?\s*)$/u;
const PLAIN_SECTION = /^[\w.\- ]+$/u;
/** A base64 run with its padding (`S0VZ…NWY=`): the whole line is a value, never a `key=` with an empty value. */
const BASE64_RUN = /^\s*[A-Za-z0-9+/]{8,}={1,2}\s*$/u;
/** A structural line: blank, a document separator, brackets only, or a key with no value (a nested section). */
const STRUCTURE = new RegExp(String.raw`^\s*(?:$|---\s*$|[{}[\],]+\s*$|${KEY}\s*[=:]\s*[{[]?\s*$)`, "u");
/** A registry-scoped `.npmrc` setting (`//host/path/:_authToken=VALUE`): its key holds `:` and `/`, so it is read up to the `=` (a `// comment` is not one). */
const SCOPED_SETTING = /^(\s*\/\/[^\s=]+=\s*)(\S.*?)\s*$/u;
/** `KEY=VALUE`, `KEY: VALUE`, `"key": "value",`, `export KEY=VALUE` — the key part kept. */
const ASSIGNMENT = new RegExp(String.raw`^(\s*${KEY}\s*[=:]\s*)(\S.*?)(,?)\s*$`, "u");
/** A YAML block-scalar indicator (`|`, `|-`, `>+`, `|2`): every following line indented deeper than its key is the value. */
const BLOCK_SCALAR = /^[|>][+-]?[1-9]?[+-]?$/u;

/** One line of a secret file as a model may read it (comments, headers and assignments; no multi-line state). */
function redactLine(line: string, marker: string): string {
  const comment = COMMENT.exec(line);
  if (comment !== null) return comment[2]!.length === 0 ? line : `${comment[1]}${redactLine(comment[2]!, marker)}`;
  if (BASE64_RUN.test(line)) return marker;
  const scoped = SCOPED_SETTING.exec(line);
  if (scoped !== null) return `${scoped[1]}${marker}`;
  if (STRUCTURE.test(line)) return line;
  const section = SECTION.exec(line);
  if (section !== null) {
    if (PLAIN_SECTION.test(section[2]!)) return line;
    const name = /^[\w.\-]+/u.exec(section[2]!)?.[0];
    return `${section[1]}${name === undefined ? marker : `${name} ${marker}`}${section[3]}`;
  }
  const assignment = ASSIGNMENT.exec(line);
  return assignment === null ? marker : `${assignment[1]}${marker}${assignment[3]}`;
}

/** The indentation of a line (its leading blanks). */
function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/**
 * `text` of the file at `path` as a model may read it: unchanged when the
 * name is not a secret file's; otherwise every value replaced by the policy's
 * secret marker. Keys, section names, comment markers and PEM armour are
 * kept; a comment's body is read like a line (a commented-out setting keeps
 * its key, other comment text is hidden); a PEM body or a YAML block scalar
 * becomes one marker; a line that is neither structure nor an assignment is
 * a value on its own and is replaced.
 */
export function redactSecretFileText(path: string, text: string, policy: PrivacyPolicy): string {
  if (!isSecretFile(path)) return text;
  const marker = redactionReplacement("secret", policy);
  const out: string[] = [];
  let inPem = false, blockIndent: number | undefined, valueMarked = false;
  for (const line of text.split("\n")) {
    if (inPem) {
      if (PEM_END.test(line)) { inPem = false; out.push(line); }
      else if (!valueMarked) { valueMarked = true; out.push(marker); }
      continue;
    }
    if (blockIndent !== undefined) {
      if (line.trim().length === 0) { out.push(line); continue; }
      if (indentOf(line) > blockIndent) {
        if (!valueMarked) { valueMarked = true; out.push(`${" ".repeat(indentOf(line))}${marker}`); }
        continue;
      }
      blockIndent = undefined;
    }
    if (PEM_BEGIN.test(line)) { inPem = true; valueMarked = false; out.push(line); continue; }
    const assignment = ASSIGNMENT.exec(line);
    if (assignment !== null && BLOCK_SCALAR.test(assignment[2]!)) { blockIndent = indentOf(line); valueMarked = false; out.push(line); continue; }
    out.push(redactLine(line, marker));
  }
  return out.join("\n");
}
