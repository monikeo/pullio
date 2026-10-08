/** Short recovery guidance for extraction and transfer errors shown in the UI. */
export function getMediaErrorGuidance(message: string): string {
  const error = message.toLowerCase();

  if (/private|members.only|login required|sign.?in|authentication|cookie|captcha|checkpoint|security check|platform challenge|\bblocked\b|http\s*412|\b403\b/.test(error)) {
    return 'Open the link in its source app and confirm you can view it. If it needs your account, add your own session cookies in Settings. Pullio cannot bypass access checks.';
  }
  if (/deleted|removed|expired|not found|\b404\b/.test(error)) {
    return 'Check that the link is current and the post is still available to view on its source platform.';
  }
  if (/timeout|timed out|network|connection|temporar|\b429\b|rate limit|\b50[0234]\b/.test(error)) {
    return 'Check your connection, wait a moment, then retry.';
  }
  if (/unsupported|no downloadable|no suitable/.test(error)) {
    return 'This link may not expose a downloadable media stream. Confirm it opens in the source platform and try a direct post link.';
  }
  if (/resolution|format|stream|codec|merge/.test(error)) {
    return 'Try another available format or choose Best available quality.';
  }
  return 'Confirm the link opens in its source platform, then retry. Restricted posts may require your own session cookies in Settings.';
}

export function mediaErrorNeedsCookies(message: string): boolean {
  return /private|members.only|login required|sign.?in|authentication|cookie|captcha|checkpoint|security check|platform challenge|\bblocked\b|http\s*412|\b403\b/i.test(message);
}
