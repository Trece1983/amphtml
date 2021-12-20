goog.module('amp.validator');

// from //third_party/javascript/amp_validator:validator_jspb_proto
const ValidationError = goog.require('proto.amp.validator.ValidationError');
// from //third_party/javascript/amp_validator:validator_jspb_proto
const ValidationResult = goog.require('proto.amp.validator.ValidationResult');
// from //third_party/javascript/closure/asserts
const asserts = goog.require('goog.asserts');
// from //third_party/javascript/closure/crypt:base64
const base64 = goog.require('goog.crypt.base64');
// from //third_party/javascript/closure/uri:utils
const uriUtils = goog.require('goog.uri.utils');

let wasmModule;

/**
 * Initialize WebAssembly module. This function must be called before all other
 * functions.
 *
 * @async
 */
async function init() {
  if (!wasmModule) {
    wasmModule = await loadValidatorWasm();
  }
}

/**
 * An object holding both number-to-string mapping and string-to-number mapping
 * of a protocol buffer enum.
 */
class ProtobufEnum {
  /**
   * @param {Object!} jspbObject Enum generated by go/jspb. This is a JavaScript
   * plain object containing a string-to-number mapping of the enum.
   */
  constructor(jspbObject) {
    const entries = Object.entries(jspbObject);
    this.numberByName = new Map(entries);
    this.nameByNumber = new Map(entries.map(([name, number]) => [number, name]));
  }
}

const CODE = new ProtobufEnum(ValidationError.Code);
const SEVERITY = new ProtobufEnum(ValidationError.Severity);
const STATUS = new ProtobufEnum(ValidationResult.Status);

/**
 * Transforms the fields in a ValidationError from number to string
 * @param {Object!} error a ValidationError whose values are numeric
 * @return {Object!}
 */
function stringifyValidationErrorFields(error) {
  return {
    ...error,
    params: error.paramsList,
    severity: SEVERITY.nameByNumber.get(error.severity),
    code: CODE.nameByNumber.get(error.code),
  };
}

/**
 * Creates a ValidationError by transforming the fields from string to number
 * @param {Object!} error an object whose strusture is the same as
 *   ValidationError, except that the fields are strings.
 * @return {Object!} a ValidationError
 */
function digitizeValidationErrorFields(error) {
  return {
    ...error,
    severity: SEVERITY.numberByName.get(error.severity),
    code: CODE.numberByName.get(error.code),
  };
}

/**
 * When transforming validation errors and validation results from jspb to plain
 * objects, the protobuf base64 string is also attached to the output.
 * Hence when a plain object neeeds to be transformed back to protobuf,
 * the attached base64 could be directly used.
 */
const PB_BASE64 = Symbol('PB_BASE64');

/**
 * Validates a document input as a string.
 *
 * @param {string} input
 * @param {string=} opt_htmlFormat the allowed format; defaults to 'AMP'.
 * @return {Object!} Validation Result (status and errors)
 */
function validateString(input, opt_htmlFormat) {
  let htmlFormat = 'AMP';
  if (opt_htmlFormat) {
    htmlFormat = opt_htmlFormat.toUpperCase();
  }
  asserts.assertExists(wasmModule, `WebAssembly is uninitialized`);
  const resultBase64 =
      wasmModule.validateString(input, htmlFormat, /*maxErrors=*/ -1);
  const resultJspb = ValidationResult.deserializeBinary(resultBase64);
  const resultObject = resultJspb.toObject();
  resultObject.errors = resultJspb.getErrorsList().map((errorJspb) => {
    const errorObject = stringifyValidationErrorFields(errorJspb.toObject());
    errorObject[PB_BASE64] =
        base64.encodeByteArray(errorJspb.serializeBinary());
    return errorObject;
  });
  resultObject.status =
      STATUS.nameByNumber.get(resultObject.status);
  resultObject[PB_BASE64] = resultBase64;
  return resultObject;
}

/**
 * Renders the error message for a single error.
 *
 * @param {!Object} error
 * @return {string}
 */
function renderErrorMessage(error) {
  asserts.assertExists(wasmModule, `WebAssembly is uninitialized`);
  return wasmModule.renderErrorMessage(error[PB_BASE64]);
}

/**
 * @param {!Object} validationResult
 * @param {string} filename to use in rendering error messages.
 * @param {string} inputContents
 * @return {string}
 */
function renderInlineResult(validationResult, filename, inputContents) {
  asserts.assertExists(wasmModule, `WebAssembly is uninitialized`);
  return wasmModule.renderInlineResult(
      validationResult[PB_BASE64],
      filename,
      inputContents,
  );
}

/**
 * Checks if the given URL is an AMP cache URL
 * @param {string} url
 * @return {boolean}
 */
function isAmpCacheUrl(url) {
  return uriUtils.getDomain(url) === 'cdn.ampproject.org';
}

/**
 * Renders one line of error output.
 * @param {string} filenameOrUrl
 * @param {!Object} error
 * @return {string}
 */
function errorLine(filenameOrUrl, error) {
  const line = error.line ?? 1;
  const col = error.col ?? 0;
  let errorLine = `${uriUtils.removeFragment(filenameOrUrl)}:${line}:${col} ${
      renderErrorMessage(error)}`;
  if (error.specUrl) {
    errorLine += ` (see ${error.specUrl})`;
  }
  return errorLine;
}

/**
 * Log validation result to the console, distinguishing warnings and errors.
 * @param {!Object} validationResult
 * @param {string} url
 */
function logValidationResult(validationResult, url) {
  const {
    status,
    errors,
  } = validationResult;
  if (status === ValidationResult.Status.PASS) {
    console.info('AMP validation successful.');
    console.info(
        `Review our 'publishing checklist' to ensure successful AMP document` +
        `distribution. See https://go.amp.dev/publishing-checklist`);
    if (errors.length === 0) {
      return;
    }
  } else if (status !== ValidationResult.Status.FAIL) {
    console.error(
        'AMP validation had unknown results. This indicates a validator ' +
        'bug. Please report at https://github.com/ampproject/amphtml/issues .');
  }
  if (status === ValidationResult.Status.FAIL) {
    console.error('AMP validation had errors:');
  } else {
    console.error('AMP validation had warnings:');
  }
  for (const error of errors) {
    if (error.severity === ValidationError.Severity.ERROR) {
      console.error(errorLine(url, error));
    } else {
      console.warn(errorLine(url, error));
    }
  }
  if (errors.length !== 0) {
    console.info(`See also https://validator.amp.dev/?experimental_wasm=1#url=${
        encodeURIComponent(uriUtils.removeFragment(url))}`);
  }
}

/**
 * Validates a URL input, and logs the result to console.
 * @param {string} url
 * @async
 */
async function validateUrlAndLog(url) {
  asserts.assert(
      isAmpCacheUrl(url) === false,
      'Attempting to validate an AMP cache URL.' +
          'Please use #development=1 on the origin URL instead.');
  const [
    response,
  ] = await Promise.all([
    fetch(url),
    init(),
  ]);
  asserts.assert(response.status === 200, `Failed to fetch ${url}`);
  const html = await response.text();
  let format = 'AMP';
  uriUtils.parseQueryData(uriUtils.getFragment(url), (key, value) => {
    if (key === 'development') {
      format = value === '1' ? 'AMP' : value;
    }
  });
  const validationResult = validateString(html, format);
  logValidationResult(validationResult, url);
}

goog.exportSymbol('amp.validator.init', init);
goog.exportSymbol('amp.validator.renderErrorMessage', renderErrorMessage);
goog.exportSymbol('amp.validator.renderInlineResult', renderInlineResult);
goog.exportSymbol('amp.validator.validateString', validateString);
goog.exportSymbol('amp.validator.validateUrlAndLog', validateUrlAndLog);
