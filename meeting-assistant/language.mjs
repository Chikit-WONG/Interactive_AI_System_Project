const englishErrors = {
  BAD_INPUT: 'Check the required fields and their character limits.',
  JSON_REQUIRED: 'The request must use JSON.', TOO_LARGE: 'This input is too long.',
  INVALID_JSON: 'The request does not contain a valid JSON object.',
  SESSION_NOT_RUNNING: 'Start or resume the session before adding speech or running analysis.',
  STALE_ANALYSIS: 'The session, profile or language changed. The old analysis was discarded.',
  KEY_MISSING: 'Set the DeepSeek API key in the local .env file, then restart the service.',
  NO_TRANSCRIPT: 'Add meeting speech before running analysis.',
  PROFILE_MISSING: 'Set your name and responsibilities so Meeting Cue can assess relevance.',
  BUSY: 'Analysis is already running. Wait for it to finish.',
  LOCAL_ONLY: 'Only local access is allowed.', FOREIGN_ORIGIN: 'A request from another website was rejected.',
  STALE_SESSION: 'This action belongs to a previous meeting and was not applied.',
  STALE_SESSION_GENERATION: 'The session start or stop state changed. This outdated action was not applied.',
  SESSION_FULL: 'This session has reached 1,000 utterances. Export it before creating a new session.',
  INVALID_SOURCE: 'Choose a valid input source.', INVALID_LANGUAGE: 'Choose English or Chinese.',
  NOT_FOUND: 'The requested record or file was not found.',
  OUTDATED_ALERT: 'Your role or background changed. This alert is retained as history; run analysis for an updated alert.',
  INVALID_TRANSITION: 'This action is not available for the current response status.',
  NOT_CONFIRMED: 'Confirm your reply before copying it or recording that you sent it.',
  ALREADY_SENT: 'A sent record cannot be changed to no response needed.',
  INVALID_ACTION: 'Unknown action.', METHOD_NOT_ALLOWED: 'This request method is not supported.',
  SERVER_ERROR: 'The request could not be completed. Please try again.',
  ANALYSIS_FAILED: 'Analysis failed. Your input has been retained.',
  ANALYSIS_CANCELLED: 'Analysis was cancelled and its output was not used.',
  PROVIDER_UNREACHABLE: 'The DeepSeek connection failed or timed out. Your input has been retained; try again.',
  PROVIDER_REJECTED: 'DeepSeek rejected the request. Check the local API key, account balance and request limits.',
  INVALID_BASE_URL: 'This version connects only to the official https://api.deepseek.com API.',
  INVALID_MODEL_OUTPUT: 'DeepSeek returned incomplete or invalid output. No replacement result was invented. Try again.',
  INVALID_SOURCES: 'DeepSeek cited an unknown or outdated source. The result was not used.',
  FEEDBACK_ID_CONFLICT: 'This submission ID already belongs to different feedback.',
  INVALID_FEEDBACK: 'Check the experience stage, topic, rating and feedback character limits.',
  FEEDBACK_ALERT_NOT_FOUND: 'This alert is not in the current meeting. Select another alert or exclude session context.',
  FEEDBACK_STORAGE_ERROR: 'Feedback could not be saved locally. Your form content is retained.',
  FEEDBACK_READ_ERROR: 'Saved feedback could not be read. Check the local service.'
};

export function localizeError(code, original, language = 'en') {
  if (language === 'zh') return original;
  return englishErrors[code] || (/\p{Script=Han}/u.test(original) ? 'The request could not be completed. Check your input and try again.' : original);
}
