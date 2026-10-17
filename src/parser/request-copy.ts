/**
 * Claude Code が API へ送った本文の写し（api-request-blob 行）を発言として保存したターンの書き出し。
 * 写しは system-reminder のブロックで始まり、その後ろに本物のプロンプトが続く。
 * 実データでは、正規の会話のターンはこの形で始まらなかった。
 */
export const REQUEST_COPY_SIGNATURE = '[User]\n<system-reminder>';
const ASSISTANT_HEADER = '\n\n[Assistant]\n';
const REMINDER_END = '</system-reminder>';

/**
 * 写しを除いたプロンプトと回答。写しは [User] 節の先頭から、その節の最後の閉じタグまでとする。
 * 写しの中で閉じタグが引用されていても止まらないため。プロンプトが閉じタグを含めば、その手前まで消える。
 * 写しを残すより本物の発言の一部を失う方を選んだ。修復前の実データの 296 ターンに、閉じタグを含むプロンプトは無かった。
 * 閉じタグが無ければ [User] 節全体を写しとみなす。
 */
export function stripRequestCopy(text: string): { prompt: string; assistant: string } {
  const at = text.indexOf(ASSISTANT_HEADER);
  const user = at < 0 ? text : text.slice(0, at);
  const assistant = at < 0 ? '' : text.slice(at + ASSISTANT_HEADER.length);
  const end = user.lastIndexOf(REMINDER_END);
  const prompt = end < 0 ? '' : user.slice(end + REMINDER_END.length).trim();
  return { prompt, assistant };
}
