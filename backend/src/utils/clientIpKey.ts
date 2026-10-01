// ARR può accodare la porta del client (includePortInXForwardedFor): la chiave è solo l'IP.
export const clientIpKey = (req: { ip?: string }) =>
  (req.ip ?? '').replace(/^\[([^\]]+)\](?::\d+)?$/, '$1').replace(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/, '$1');
