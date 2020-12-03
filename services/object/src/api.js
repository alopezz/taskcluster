const { APIBuilder } = require('taskcluster-lib-api');

/**
 * Known download methods, in order of preference (preferring earlier
 * methods)
 */
const DOWNLOAD_METHODS = [
  'simple',
  'HTTP:GET',
];

let builder = new APIBuilder({
  title: 'Taskcluster Object Service API Documentation',
  description: [
    'The object service provides HTTP-accessible storage for large blobs of data.',
  ].join('\n'),
  serviceName: 'object',
  apiVersion: 'v1',
  errorCodes: {
    NoMatchingMethod: 406,
  },
  context: ['cfg', 'db', 'backends', 'middleware'],
});

builder.declare({
  method: 'put',
  route: '/upload/:name',
  name: 'uploadObject',
  input: 'upload-object-request.yml',
  stability: 'experimental',
  category: 'Upload',
  scopes: 'object:upload:<projectId>:<name>',
  title: 'Upload backend data (temporary)',
  description: [
    'Upload backend data.',
  ].join('\n'),
}, async function(req, res) {
  let { projectId, expires, data } = req.body;
  let { name } = req.params;

  await req.authorize({ projectId, name });

  const backend = this.backends.forUpload({ name, projectId });

  data = Buffer.from(data, 'base64');

  // note that it's possible for this process to crash mid-stream, with a row in the DB
  // but no data in the backend.
  try {
    await this.db.fns.create_object(name, projectId, backend.backendId, {}, new Date(expires));
  } catch (err) {
    if (err.code === 'P0004') {
      return res.reportError('RequestConflict', err.message, { name, projectId, backendId: backend.backendId });
    }

    throw err;
  }
  const [object] = await this.db.fns.get_object(name);

  await backend.temporaryUpload(object, data);

  return res.reply({});
});

builder.declare({
  method: 'put',
  route: '/download-object/:name(*)', // name TBD; https://github.com/taskcluster/taskcluster/issues/3940
  name: 'downloadObject',
  input: 'download-object-request.yml',
  output: 'download-object-response.yml',
  stability: 'experimental',
  category: 'Download',
  scopes: 'object:download:<name>',
  title: 'Download object data',
  description: [
    'Get information on how to download an object.  Call this endpoint with a list of acceptable',
    'download methods, and the server will select a method and return the corresponding payload.',
    'Returns a 406 error if none of the given download methods are available.',
    '',
    'See [Download Methods](https://docs.taskcluster.net/docs/reference/platform/object/download-methods) for more detail.',
  ].join('\n'),
}, async function(req, res) {
  let { name } = req.params;
  const { acceptDownloadMethods } = req.body;
  const [object] = await this.db.fns.get_object(name);

  if (!object) {
    return res.reportError('ResourceNotFound', 'Object "{{name}}" not found', { name });
  }

  const backend = this.backends.get(object.backend_id);

  const callerMethods = Object.keys(acceptDownloadMethods);
  const backendMethods = await backend.availableDownloadMethods(object);
  const matchingMethods = DOWNLOAD_METHODS.filter(
    m => backendMethods.includes(m) && callerMethods.includes(m));

  if (matchingMethods.length < 1) {
    return res.reportError(
      'NoMatchingMethod',
      'Object supports methods {{methods}}',
      { methods: backendMethods.join(', ') });
  }

  // DOWNLOAD_METHODS is ordered by preference, so "the best" is just the first matching method
  const method = matchingMethods[0];
  const params = acceptDownloadMethods[method];

  // apply middleware
  if (!await this.middleware.downloadObjectRequest(req, res, object, method, params)) {
    return;
  }

  const result = await backend.downloadObject(object, method, params);

  return res.reply(result);
});

builder.declare({
  method: 'get',
  route: '/download/:name(*)',
  name: 'download',
  stability: 'experimental',
  category: 'Download',
  scopes: 'object:download:<name>',
  title: 'Get an object\'s data',
  description: [
    'Get the data in an object directly.  This method does not return a JSON body, but',
    'redirects to a location that will serve the object content directly.',
    '',
    'URLs for this endpoint, perhaps with attached authentication (`?bewit=..`),',
    'are typically used for downloads of objects by simple HTTP clients such as',
    'web browsers, curl, or wget.',
    '',
    'This method is limited by the common capabilities of HTTP, so it may not be',
    'the most efficient, resilient, or featureful way to retrieve an artifact.',
    'Situations where such functionality is required should ues the',
    '`downloadObject` API endpoint.',
    '',
    'See [Simple Downloads](https://docs.taskcluster.net/docs/reference/platform/object/simple-downloads) for more detail.',
  ].join('\n'),
}, async function(req, res) {
  const { name } = req.params;
  const method = 'simple';
  const [object] = await this.db.fns.get_object(name);

  if (!object) {
    return res.reportError('ResourceNotFound', 'Object "{{name}}" not found', { name });
  }

  const backend = this.backends.get(object.backend_id);

  const backendMethods = await backend.availableDownloadMethods(object);
  if (!backendMethods.includes(method)) {
    // all backends should support 'simple', but just in case..
    return res.reportError(
      'NoMatchingMethod',
      'Object supports methods {{methods}}',
      { methods: backendMethods.join(', ') });
  }

  // apply middleware
  if (!await this.middleware.simpleDownloadRequest(req, res, object)) {
    return;
  }

  const result = await backend.downloadObject(object, method, true);

  return res.redirect(303, result.url);
});

module.exports = builder;
