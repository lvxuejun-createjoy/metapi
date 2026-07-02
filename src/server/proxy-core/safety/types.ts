export type ProxySafetyDirection = 'request' | 'response';

export type ProxySafetyRuleCategory = 'secret' | 'env_file' | 'dangerous_command';

export type ProxySafetyConfig = {
  enabled: boolean;
  requestEnabled: boolean;
  responseEnabled: boolean;
  blockSecrets: boolean;
  blockEnvFiles: boolean;
  blockDangerousCommands: boolean;
};

export type ProxySafetyFinding = {
  ruleId: string;
  category: ProxySafetyRuleCategory;
  direction: ProxySafetyDirection;
  message: string;
};

export type ProxySafetyVerdict = {
  allowed: boolean;
  findings: ProxySafetyFinding[];
};

export type ProxySafetyRule = {
  id: string;
  category: ProxySafetyRuleCategory;
  directions: ProxySafetyDirection[];
  pattern: RegExp;
  message: string;
};
