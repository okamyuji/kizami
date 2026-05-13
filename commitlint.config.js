export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    // 日本語コミットメッセージでは sentence-case 等の概念が当てはまらないため無効化する
    'subject-case': [0],
    // 日本語の本文は欧文の 100 文字制約と相性が悪いため、強制しない
    'body-max-line-length': [0],
    'footer-max-line-length': [0],
  },
};
