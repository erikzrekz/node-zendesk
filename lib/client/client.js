// client.js - main client file that does most of the processing
'use strict';

var Client = require('./client').Client;

const fs = require('fs');
const constants = require('constants');
const request = require('request');
const util = require('util');
const EventEmitter = require('events').EventEmitter;
const qs = require('querystring');
const async = require('async');
const path = require('path');
const flatten = require('flatten');
const throttler = require('./throttle');
const pjson = require('./../../package.json');
const failCodes = {
  400: 'Bad Request',
  401: 'Not Authorized',
  403: 'Forbidden',
  404: 'Item not found',
  405: 'Method not Allowed',
  409: 'Conflict',
  422: 'Unprocessable Entity',   // zendesk sends this one back when you re-use an organization name
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  503: 'Service Unavailable'
};


Client = exports.Client = function (options) {
  this.options = options;
  this.sideLoad = [];
  this.userAgent = 'node-zendesk/' + pjson.version + ' (node/' + process.versions.node + ')';
  // Each client has its own cookies to isolate authentication between clients
  this._request = request.defaults({
    jar:      this.options.get('no-cookies') ? false : request.jar(),
    encoding: this.options.get('encoding') || null,
    timeout:  this.options.get('timeout')  || 240000,
    proxy:    this.options.get('proxy')    || null,
    secureOptions: constants.SSL_OP_NO_TLSv1_2,
    forever: true,
    pool: {maxSockets: 100}
  });

  if (!this.jsonAPINames) {
    this.jsonAPINames = [];
  }

  if (typeof this.options.get !== 'function') {
    this.options.get = function (key) {
      return this[key];
    };
  }

};

util.inherits(Client, EventEmitter);

Client.prototype.request = function (method, uri) {
  let options = Object.assign({}, this.options);
  let url;
  let self = this;
  let res;
  let args = Array.prototype.slice.call(arguments);
  let callback = args.pop();
  let body = typeof args[args.length - 1] === 'object' && !Array.isArray(args[args.length - 1]) && args.pop();

  options.headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'User-Agent': self.userAgent,
    'Authorization': _authenticateRequest(this.options)
  };

  options.uri = _assembleUrl(self, uri);
  options.method = method || 'GET';
  options.proxy = this.options.get('proxy');

  if (body) {
    options.body = JSON.stringify(body);
  } else if (method !== 'GET' && options.headers['Content-Type'] === 'application/json') {
    options.body = '{}';
  }

  self.emit('debug::request', options);
  return this._request(options, function (err, response, result) {
    requestCallback(self, err, response, result, callback);
  });
};

Client.prototype.requestAll = function (...args) {
  let callback = args.pop();
  let nextPage = 'Not Null!';
  let bodyList = [];
  let statusList = [];
  let responseList = [];
  let resultList = [];
  let self = this;
  let throttle = this.options.get('throttle');
  let __request = Client.prototype.request;

  if (throttle) {
     __request = throttler(this, Client.prototype.request, throttle);
  }

  return __request.apply(this, args.concat(function (error, status, body, response, result) {
    if (error) {
      return callback(error);
    }

    statusList.push(status);
    bodyList.push(body);
    responseList.push(response);
    resultList.push(result);
    nextPage = result ? result.next_page : null;

    async.whilst(
      function () {
        if (nextPage !== null) {
          return nextPage;
        } else {
          nextPage = '';
          return nextPage;
        }
      },
      function (cb) {
        __request.apply(self, ['GET', nextPage, function (error, status, body, response, result) {
          if (error) {
            return cb(error);
          }

          statusList.push(status);
          bodyList.push(body);
          responseList.push(response);
          resultList.push(result);
          nextPage = result ? result.next_page : null;
          cb(null);
        }]);
      },
      function (err) {
        if (err) {
          callback(err);
        } else {
          return callback(null, statusList, flatten(bodyList), responseList, resultList);
        }
      }
      );
  }));
};

Client.prototype.requestUpload = function (uri, file, callback) {
  let options = Object.assign({}, this.options);
  let self = this;
  let out;
  options.uri = _assembleUrl(self, uri);
  options.method = 'POST';

  options.headers = {
    'Content-Type': 'application/binary',
    'Authorization': _authenticateRequest(this.options)
  };

  self.emit('debug::request', options);
  out = this._request(options, function (err, response, result) {
    requestCallback(self, err, response, result, callback);
  });

  fs.createReadStream(file).pipe(out);
};

Client.prototype.setSideLoad = function(arr){
  let self = this;
  self.sideLoad = arr;
}

function _authenticateRequest(options) {
  let username = options.get('username');
  let password = options.get('password');
  let token = options.get('token');
  let useOAuth = options.get('oauth');

  let auth = password ? ':' + password : '/token:' + token;
  let encoded = new Buffer(username + auth).toString('base64');
  if (useOAuth) {
    return 'Bearer ' + token;
  }

  return 'Basic ' + encoded;
}

function _assembleUrl(self, uri) {
  let remoteUri = self.options.get('remoteUri');
  let lastElement;
  let params = '';

  if (typeof uri === 'object' && Array.isArray(uri)) {
    lastElement = uri.pop();
    if (lastElement) {
      // we have received an object ex. {"sort_by":"id","sort_order":"desc"}
      if (typeof lastElement === 'object') {
        if (self.sideLoad.length){
          lastElement.include = self.sideLoad.join(',');
        }
        params = '?' + qs.stringify(lastElement);
      }
      // we have received a query string ex. '?sort_by=id&sort_order=desc'
      else if (lastElement.toString().includes('?')) {
        if (self.sideLoad.length){
          lastElement += '&include='+ self.sideLoad.join(',');
        }
        params = lastElement;
      }
      else {
        if (self.sideLoad.length){
          params = '?include=' + self.sideLoad.join(',');
        }
        uri.push(lastElement);
      }
    }
    return remoteUri + '/' + uri.join('/') + '.json' + params;
  }
  else if (typeof uri === 'string' && uri.includes(remoteUri)) {
    return remoteUri + uri;
  }
  else {
    return uri;
  }
}

function _checkRequestResponse(self, response, result, callback) {
  let statusCode; 
  let error; 
  let res;
  let retryAfter = response.headers['retry-after'];;

  if (!result) { // should this really be an error?
    error = new Error('Zendesk returned an empty result');
    error.statusCode = 204;
    return callback(error);
  }

  if (retryAfter) {
    error = new Error('Zendesk rate limits 200 requests per minute');
    error.statusCode = 429;
    error.result = result;
    error.retryAfter = retryAfter;
    return callback(error);
  }

  if (failCodes[statusCode]) {
    error = new Error('Zendesk Error (' + statusCode + '): ' + failCodes[statusCode]);
    error.statusCode = statusCode;
    error.result = result;
    error.retryAfter = null;
    return callback(error);
  }

  try {
    statusCode = response.statusCode;
    res = JSON.parse(result);
  } catch (e) {
    self.emit('debug::error', {exception: ex, code: statusCode, request: self.options, result: result});
  }

  self.emit('debug::response', {statusCode: statusCode, result: result});
  return callback(null, res);
}

function requestCallback(self, err, response, result, callback) {
  if (err) {
    return callback(err);
  }

  _checkRequestResponse(self, response, result, function(err, res) {
    if (err) {
      return callback(err);
    }
    var body = null;
    if (res) {
      if (self.jsonAPINames){
        for (var i = 0; i < self.jsonAPINames.length; i++){
          if (res.hasOwnProperty(self.jsonAPINames[i].toString())){
            body = res[self.jsonAPINames[i].toString()];
            break;
          }
        }
      }

      if (!body) {
        body = res;
      }
      if (self.hasOwnProperty('sideLoadMap')){
        body = populateFields(body, res, self.sideLoadMap);
      }
    } else {
      body = '';
    }

    return callback(null, response.statusCode, body, response, res);
  });

}

function populateFields(data, response, map){
  if (Array.isArray(data)){
    for (var i = 0; i < data.length; i++){
      var record = data[i];
      populateRecord(record);
    }
  } else {
    populateRecord(data);
  }
  return data;

  function populateRecord(record){
    for (var i = 0; i < map.length; i++){
      var field   = map[i].field;
      var name    = map[i].name;
      var dataset = map[i].dataset;


      if (record.hasOwnProperty(field) && response.hasOwnProperty(dataset)){
        //If specifying all, then put everything in response[dataset] to record[name]
        if ( map[i].hasOwnProperty('all') && map[i].all === true ){
          record[name] = response[dataset];
        } else {
          var key = 'id';
          if (map[i].hasOwnProperty('dataKey')){
            key = map[i].dataKey;
          }
          if (map[i].hasOwnProperty('array') && map[i].array){
            record[name] = findAllRecordsById(response[dataset], key, record[field]);
          } else {
            record[name] = findOneRecordById(response[dataset], key, record[field]);
          }
        }
      }
    }
    return record;
  }
}

function findAllRecordsById(data, key, id){
  var arr = [];
  for (var i = 0; i < data.length; i++){
    if (data[i][key] === id){
      arr.push(data[i]);
    }
  }
  return arr;
}

function findOneRecordById(data, key, id){
  for (var i = 0; i < data.length; i++){
    if (data[i][key] === id){
      return data[i];
    }
  }
  return null;
}
