import { ownerNameFrom } from '../config.ts';
import type { NightQuestion } from './protocol.ts';

/**
 * Night shift policy: whether a question may be decided at all,
 * checked before any model sees it. Pure and deterministic; the decider is never
 * asked about a question this policy defers, and when in doubt it defers, so the
 * dialog opens and waits for the user.
 *
 * Guarded bash confirmations (ui confirm) and review consent dialogs (ui custom)
 * never reach this path: the bridge only forwards ask_user_choice and
 * ask_user_question tool calls. A review consent the model relays through
 * ask_user_choice is caught by the `permissions` rule (consent, grant, authorize).
 */

export type PolicyRule = 'inactive' | 'tool' | 'multi-select' | 'custom-only' | 'item-count' | 'option-count' | `sensitive:${string}`;

export type PolicyOutcome = { allow: true } | { allow: false; rule: PolicyRule; reason: string };

const DECIDABLE_TOOLS = new Set(['ask_user_choice', 'ask_user_question']);
const MAX_ITEMS = 4;
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 4;

/**
 * Topics Mirador never decides at night, in English and Spanish. Patterns run on
 * normalized text (see `normalize`: lower case, accents and invisible characters
 * removed, compatibility forms folded), so they are written without accents.
 * The first matching rule names the topic; specific rules come before general ones.
 */
export const SENSITIVE_RULES: ReadonlyArray<{ id: string; description: string; pattern: RegExp }> = [
  {
    id: 'env-file',
    description: '.env files and environment variables (archivos .env, variables de entorno)',
    pattern: /(^|[^\w])\.env\b|\bdotenv\b|\benv(ironment)? var(iable)?s?\b|\bvariables? de entorno\b/,
  },
  {
    id: 'ssh',
    description: 'SSH keys and config (~/.ssh, id_rsa, authorized_keys, known_hosts)',
    pattern: /\.ssh\b|\bssh\b|\bid_(rsa|dsa|ecdsa|ed25519)\b|\bauthorized_keys\b|\bknown_hosts\b/,
  },
  {
    id: 'config-secrets',
    description: 'secret-holding config under the home folder (~/.config, .netrc, .npmrc, .aws, .kube, .gnupg, keyrings, vaults)',
    pattern: /~\/\.config\b|\$home\/\.config\b|\.netrc\b|\.npmrc\b|\.pypirc\b|\.aws\b|\.kube\b|\.docker\/config|\.gnupg\b|\bgpg\b|\bkeyrings?\b|\bkeychains?\b|\bvaults?\b|\bboveda\b/,
  },
  {
    id: 'certificates',
    description: 'certificates and key files (certificate, certificado, .pem, .p12, .pfx, .crt, .key)',
    pattern: /\bcertificates?\b|\bcerts?\b|\bcertificados?\b|\.(pem|p12|pfx|crt|key)\b/,
  },
  {
    id: 'secrets',
    description: 'secrets, tokens, passwords, credentials and keys (secretos, contrasenas, credenciales, claves, llaves)',
    pattern:
      /\bsecrets?\b|\bsecretos?\b|\btokens?\b|\bpasswords?\b|\bpasswd\b|\bpassphrases?\b|\bcontrasenas?\b|\bcredentials?\b|\bcredenciales?\b|\bapi[ _-]?keys?\b|\bkeys?\b|\bclaves?\b|\bllaves?\b|\bprivate key\b/,
  },
  {
    id: 'permissions',
    description: 'permissions, privileges, sudo, authorization and consent (permisos, privilegios, autorizar, consentimiento)',
    pattern:
      /\bpermissions?\b|\bpermisos?\b|\bsudo\b|\bdoas\b|\bpkexec\b|\bprivileges?\b|\bprivilegios?\b|\bchmod\b|\bchown\b|\bsetuid\b|\b(as|como) root\b|\broot (access|user|privileges?)\b|\busuario root\b|\bauthori[sz]\w*|\bautoriz\w*|\bconsent\w*|\bconsentimiento\b|\bgrant(s|ed|ing)?\b|\bconceder\b|\bgentle_review\b|\breview authority\b/,
  },
  {
    id: 'destructive',
    description: 'deleting, wiping or force-pushing (borrar, eliminar, forzar push, reset --hard)',
    pattern:
      /\bdelet\w*|\bremov\w*|\berase\b|\bwipe\b|\bpurge\b|\bdestroy\w*|\buninstall\w*|\brm\s+-|\bdrop (table|database|schema)\b|\btruncate\b|\bforce[- ]?push\w*|\bpush\s+(-f\b|--force)|--force\b|\breset\s+--hard\b|\bgit clean\b|\bborr\w*|\belimin\w*|\bsuprim\w*|\bdestru\w*|\bdesinstal\w*|\bforzar\b|\bforzado\b/,
  },
  {
    id: 'production',
    description: 'production, deploys, releases, publishing and pushing (produccion, desplegar, publicar)',
    pattern: /\bproduction\b|\bprod\b|\bproduccion\b|\bdeploy\w*|\bdespleg\w*|\bdespliegue\w*|\breleas\w*|\bpublish\w*|\bpublic(ar|o|amos|a|acion)\b|\blanzamiento\b|\bpush\w*/,
  },
  {
    id: 'payments',
    description: 'payments, billing and purchases (pagos, facturas, cobros, tarjetas, compras)',
    pattern:
      /\bpay(s|ing|ment|ments)?\b|\bpaid\b|\bbilling\b|\binvoices?\b|\bcredit cards?\b|\bpurchas\w*|\bsubscri(be|ption)\w*|\bcharge (the )?card\b|\bpagos?\b|\bpagar\w*|\bfactur\w*|\bcobr\w*|\btarjetas?\b|\btransferencias?\b|\bcompr(a|ar|as)\b|\bsuscripci\w*/,
  },
];

/** Lower case, compatibility forms folded, accents and invisible (format) characters removed. */
function normalize(text: string): string {
  return text.normalize('NFKD').replace(/\p{M}/gu, '').replace(/\p{Cf}/gu, '').toLowerCase();
}

/** The id of the first sensitive topic `text` mentions, or null. */
export function findSensitive(text: string): string | null {
  const plain = normalize(text);
  for (const rule of SENSITIVE_RULES) if (rule.pattern.test(plain)) return rule.id;
  return null;
}

const defer = (rule: PolicyRule, reason: string): PolicyOutcome => ({ allow: false, rule, reason });

/**
 * Whether Mirador may ask its decider about `question` (`active`: the night shift is on). The
 * reasons name the owner as config `ownerName` says (`ownerName`; unset or not valid: "the user"); a
 * default parameter, so `checkQuestion.length` stays 2: the policy reads no task.
 */
export function checkQuestion(question: NightQuestion, active: boolean, ownerName: unknown = undefined): PolicyOutcome {
  const owner = ownerNameFrom(ownerName);
  if (!active) return defer('inactive', 'the night shift is off');
  if (!DECIDABLE_TOOLS.has(question.tool)) return defer('tool', `${String(question.tool)} is not a question tool`);
  const { items } = question;
  if (items.length === 0 || items.length > MAX_ITEMS) return defer('item-count', `${items.length} questions (1-${MAX_ITEMS} can be decided)`);
  if (items.some((item) => item.multiSelect)) return defer('multi-select', `a multi-select question needs ${owner}`);
  if (question.allowCustomResponse && items.some((item) => item.options.length === 0)) return defer('custom-only', `a free-text answer needs ${owner}`);
  const badOptions = items.find((item) => item.options.length < MIN_OPTIONS || item.options.length > MAX_OPTIONS);
  if (badOptions) return defer('option-count', `${badOptions.options.length} options (${MIN_OPTIONS}-${MAX_OPTIONS} can be decided)`);
  for (const item of items) {
    const texts = [item.question, item.header, ...item.options.flatMap((option) => [option.label, option.description])];
    for (const text of texts) {
      const topic = findSensitive(text);
      if (topic) return defer(`sensitive:${topic}`, `mentions sensitive material (${topic}); it stays pending for ${owner}`);
    }
  }
  return { allow: true };
}
