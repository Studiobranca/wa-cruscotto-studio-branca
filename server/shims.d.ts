// Shim dichiarazioni per i moduli IMAP/SMTP privi di tipi pubblicati.
// esbuild li bundla comunque; questo serve solo a tenere pulito `tsc --noEmit`.
declare module 'mailparser';
declare module 'nodemailer';
