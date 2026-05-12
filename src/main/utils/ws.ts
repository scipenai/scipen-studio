process.env.WS_NO_BUFFER_UTIL = '1';
process.env.WS_NO_UTF_8_VALIDATE = '1';

const wsModule = await import('ws');

export default wsModule.default;
