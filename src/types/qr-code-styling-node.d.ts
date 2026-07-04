/**
 * The CommonJS build (`qr-code-styling.common.js`) is Node-safe and exposes a named
 * `QRCodeStyling` export but has no type declarations of its own; we map
 * it onto the package's published types here.
 */
declare module 'qr-code-styling-node/lib/qr-code-styling.common.js' {
  import QRCodeStyling from 'qr-code-styling-node';
  export { QRCodeStyling };
  const _default: { QRCodeStyling: typeof QRCodeStyling };
  export default _default;
}
