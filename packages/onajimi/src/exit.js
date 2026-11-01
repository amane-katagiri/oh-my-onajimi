export const EXIT = { FAILED: 1, USAGE: 2, RATE: 3, BUSY: 4, NEEDS_YES: 5 };

export const needsYesMessage = (subject = "") => `${subject}生成するには、見積もりを人に見せて同意を得てから --yes を付けて同じコマンドを実行する。`;

const RESUME = "時間をおいて同じコマンドで再開する。";

export const stopOf = ({ rateLimited, unavailable }, key) => {
  if (rateLimited) {
    return { code: EXIT.RATE, message: `${rateLimited[key]} で回数制限に当たって止めた。${RESUME}` };
  }
  if (unavailable) {
    return { code: EXIT.BUSY, message: `${unavailable[key]} で混雑が続いたので止めた。${RESUME}` };
  }
  return null;
};
