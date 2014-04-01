'use strict';

var system		= require('system');
var	argv		= require('minimist')(system.args);
var seq			= require('promised-io/promise').seq;
var Deferred	= require('promised-io/promise').Deferred;
var fs          = require('fs');
var URL         = require('url');
var path        = require('path');

var request     = require('request').defaults({jar: true});


if (!argv.url)
{
	console.log('Please provide a URL! (--url some_url)');
	process.exit(42);
}

if (!argv.pack || !fs.existsSync(argv.pack))
{
	console.log('Please provide a valid pack with the --pack some_path argument.');
	process.exit(42);
}

var fail = function (message)
{
	console.log('Failed with: ' + message);
	process.exit(42);
};

var succeed = function (message)
{
	console.log('Success! ' + message);
	process.exit(0);
};

var handlePostPack = function (err, response, body)
{
	if (err)
	{
		fail('Could not upload pack: ' + err);
	}
	else if(response.headers.location && /\bconf=15\b/.exec(response.headers.location))
	{
		succeed('Uploaded pack: ' + argv.pack);
	}
	else
	{
		fail('Could not find confirmation that upload went successfully.');
	}
};

var postPack = function (url)
{
	var r = request.post(url, handlePostPack);
	var form = r.form();
	form.append('file', fs.createReadStream(argv.pack));
	form.append('theme[]', 'default-bootstrap');
	form.append('submitImport', '1');
};

var handleLogin = function (err, response, body)
{
	console.log(body);
	var okJson = true;

	try {
		body = JSON.parse(body);
	}
	catch (err) {
		okJson = false;
	};

	if (!okJson || body.hasErrors)
	{
		fail('Could not log in.');
	}

	var p = URL.parse(argv.url);
	var url = p.protocol + '//' + p.host + path.dirname(p.path) + '/' + body.redirect;

	console.log('AdminTranslations is at: ' + url);
	postPack(url);
};

var p = URL.parse(argv.url);
var url = p.protocol + '//' + p.host + path.dirname(p.path) + '/ajax-tab.php';

var form = {
	email: argv.email || 'pub@prestashop.com',
	passwd: argv.password || '123456789',
	controller: 'AdminLogin',
	redirect: 'AdminTranslations',
	stay_logged_in: 1,
	submitLogin: 1
};

console.log('Will post login info to: ' + url);
request.post({url: url, form: form}, handleLogin);

