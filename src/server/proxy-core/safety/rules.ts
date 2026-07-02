import type { ProxySafetyRule } from './types.js';

export const PROXY_SAFETY_RULES: ProxySafetyRule[] = [
  {
    id: 'env_file_content',
    category: 'env_file',
    directions: ['request', 'response'],
    pattern: /(?:^|[\n\\n])\s*(?:[A-Z][A-Z0-9_]{2,}|[a-z][A-Za-z0-9_]{2,})\s*=\s*(?:sk-[A-Za-z0-9_-]{8,}|postgres(?:ql)?:\/\/\S+|mysql:\/\/\S+|mongodb(?:\+srv)?:\/\/\S+|redis:\/\/\S+|[^\s#"'`]{12,})/m,
    message: 'Detected .env-style secret assignment',
  },
  {
    id: 'private_key_material',
    category: 'secret',
    directions: ['request', 'response'],
    pattern: /-----BEGIN (?:OPENSSH|RSA|DSA|EC|PRIVATE) PRIVATE KEY-----/,
    message: 'Detected private key material',
  },
  {
    id: 'bearer_token',
    category: 'secret',
    directions: ['request'],
    pattern: /Authorization\s*:\s*Bearer\s+[A-Za-z0-9._~+/=-]{16,}/i,
    message: 'Detected bearer token',
  },
  {
    id: 'password_assignment',
    category: 'secret',
    directions: ['request'],
    pattern: /\b(?:password|passwd|pwd)\s*[:=]\s*['"]?[^'"\s]{8,}/i,
    message: 'Detected password assignment',
  },
  {
    id: 'remove_root',
    category: 'dangerous_command',
    directions: ['response'],
    pattern: /\brm\s+-[A-Za-z]*r[A-Za-z]*f[A-Za-z]*\s+(?:\/|~|\$HOME)(?:\s|$)/,
    message: 'Detected destructive recursive removal command',
  },
  {
    id: 'download_pipe_shell',
    category: 'dangerous_command',
    directions: ['response'],
    pattern: /\b(?:curl|wget)\b[^\n|;]{0,300}\|\s*(?:sudo\s+)?(?:sh|bash)\b/i,
    message: 'Detected download-and-execute shell command',
  },
  {
    id: 'reverse_shell',
    category: 'dangerous_command',
    directions: ['response'],
    pattern: /\b(?:bash\s+-i\s*>\s*&\s*\/dev\/tcp\/|nc\s+[^\n]{0,200}\s+-e\s+\/bin\/(?:sh|bash))/i,
    message: 'Detected reverse shell command',
  },
  {
    id: 'disk_destroy',
    category: 'dangerous_command',
    directions: ['response'],
    pattern: /\b(?:mkfs(?:\.[a-z0-9]+)?\s+|dd\s+[^\n]{0,200}\bof=\/dev\/)/i,
    message: 'Detected disk destructive command',
  },
  {
    id: 'credential_exfiltration',
    category: 'dangerous_command',
    directions: ['response'],
    pattern: /\b(?:cat|less|more|tail)\s+(?:~\/\.ssh\/id_(?:rsa|ed25519|ecdsa)|\.env\b)|\b(?:printenv|env)\s*(?:\||$)/i,
    message: 'Detected credential exfiltration command',
  },
];
