'use strict';

var system		= require('system');
var	argv		= require('minimist')(system.args);
var seq			= require('promised-io/promise').seq;
var Deferred	= require('promised-io/promise').Deferred;
var fs          = require('fs');
var path        = require('path');
var exec        = require('child_process').exec;

var request     = require('request').defaults({jar: true});

if (!argv.url)
{
	console.log('Please provide a URL! (--url some_url)');
	process.exit(42);
}

if (!argv.packsDir || !fs.existsSync(argv.packsDir) || !fs.lstatSync(argv.packsDir).isDirectory())
{
	console.log('Please provide a valid packs directory with the --packsDir some_path argument.');
	process.exit(42);
}

var promises = fs.readdirSync(argv.packsDir).map(function (entry) {
	if (/\.gzip$/.exec(entry))
	{
		var packPath = path.join(argv.packsDir, entry);
		return function () {
			var d = new Deferred();

			exec('nodejs install_translation_pack.js --url ' + argv.url + ' --pack ' + packPath, function (error, stdout) {
				if (error)
				{
					console.log(stdout);
					d.reject('Could not upload pack: ' + packPath);
				}
				else
				{
					console.log('Successfully imported pack: ' + packPath);
					d.resolve();
				}
			});
			return d.promise;
		};
	}
});

seq(promises).then(function () {
	console.log('Everything seems good!');
	process.exit(0);
}, function (error) {
	console.log('Uploading packs failed: ' + error);
	process.exit(42);
});