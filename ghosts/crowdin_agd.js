'use strict';

var system		= require('system');
var fs          = require('fs'); // Lol, this is not the usual fs we would expect: https://github.com/ariya/phantomjs/wiki/API-Reference-FileSystem
var	argv		= require('minimist')(system.args);
var page		= require('webpage').create();
var seq			= require('promised-io/promise').seq;
var Deferred	= require('promised-io/promise').Deferred;
var path        = require('path');
var spawn       = require('child_process').spawn;

var components = require('../vendor/phantomshop/ghosts/tools/components.js');
var I = components.actions;
var U = components.glue;

if (!argv.url)
{
	console.log('Please provide the URL! (--url some_url)');
	phantom.exit(components.errors.INVALID_URL);
}

if (!argv.shopRoot)
{
	console.log('Please provide the shop root! (--shopRoot some_filesystem_path)');
	phantom.exit(components.errors.INVALID_URL);
}

if (!argv.movePacksTo || !fs.exists(path.dirname(argv.movePacksTo)))
{
	console.log('Please provide the directory to move the  packs to and make sure it exists! (--movePacksTo some_directory)');
	phantom.exit(components.errors.INVALID_URL);
}

var willForceLiveTranslationMaybe = function () {
	console.log('Seeing if live translation needs to be forced...');
	var d = new Deferred();

	var needToForce = page.evaluate(function () {
		if($('#force-live-translation').length === 1)
		{
			$('#force-live-translation').submit();
			return true;
		}
		else
		{
			return false;
		}
	});

	if (!needToForce)
	{
		console.log('Nope, that\'s OK');
		d.resolve();
	}
	else
	{
		console.log('Yes, so, wait!');
		U.waitFor(page, '#live-translation-forced').then(d.resolve, d.reject);
	}

	return d.promise;
};

var willSetApiSettings = function () {
	console.log('Setting API settings...');
	var d = new Deferred();
	page.evaluate(function (projectIdentifier, crowdinAPIKey, crowdinVersion) {
		$('#CROWDIN_PROJECT_IDENTIFIER').val(projectIdentifier);
		$('#CROWDIN_PROJECT_API_KEY').val(crowdinAPIKey);
		$('#CROWDIN_FORCED_VERSION').val(crowdinVersion);
		$('#save-settings').click();
	}, argv.projectIdentifier, argv.crowdinAPIKey, argv.crowdinVersion);

	U.waitForURLParameter(page, 'api_settings_updated').then(function () {
		var version = page.evaluate(function () {
			return $('#check_pack_version').attr('data-pack-version');
		});

		if (version === argv.crowdinVersion)
		{
			console.log('Api settings successfully set, crowdin version is: ' + version);
			d.resolve();
		}
		else
		{
			d.reject('Could not check that the crowdin version was correctly set.');
		}
	}, d.reject);

	return d.promise;
};

var willExportSourcesToCrowdin = function () {
	var d = new Deferred();

	console.log('Exporting sources to Crowdin...');

	page.evaluate(function () {
		exportSourcesToCrowdin(true);
	});

	/*
	var n = 0;
	var interval = setInterval(function () {
		console.log('Taking screenshot ' + n);
		I.takeScreenshot(page, argv.screenshots, 'exporting_sources_' + n);
		n++;
	}, 2000);*/

	U.waitFor(page, '#sources-successfully-exported', 'any', 1000, 1000, 3600000).then(function () {
		console.log('Exported sources!! :)');
		d.resolve();
	}, d.reject);

	return d.promise;
}

var willInstallMissingModules = function () {
	var d = new Deferred();

	console.log('Install missing modules?');

	var installing = page.evaluate(function () {
		if($('#modules-are-missing').length === 1)
		{
			window.location.href = $('#modules-are-missing').attr('href');
			return true;
		}
		else
		{
			return false;
		}
	});

	if (!installing)
	{
		console.log('Not necessary.');
		d.resolve();
	}
	else
	{
		console.log('Yes, installing them.');
		U.waitForURLParameter(page, 'conf', '12').then(function () {
			page.evaluate(function () {
				window.history.back();
			});
			console.log('Modules installed!');
			U.waitFor(page, '#translatability').then(function () {
				console.log('Seems we\'re back on translatools, good!');
				d.resolve();
			}, d.reject);
		}, d.reject);
	}

	return d.promise;
};

var willRegenerateTheTranslations = function () {
	var d = new Deferred();

	console.log('Regenerating translations, if possible. May take a long time...');
	var url = 'http://api.crowdin.net/api/project/' + argv.projectIdentifier + '/export?key=' + argv.crowdinAPIKey + '&json';
	console.log('Making the request to: ' + url);

	spawn('nodejs', ['regenerate_translations.js', '--url', url]).on('exit', function (code) {
		if (code === 0 || code === 1)
		{
			if (code === 0)
			{
				console.log('Packs were built!');
			}
			else
			{
				console.log('Skipped packs building, already done too recently.');
			}
			d.resolve();
		}
		else
		{
			d.reject('Could not regenerate translations.');
		}
	});

	return d.promise;
};

var willDownloadTranslations = function () {
	var d = new Deferred();
	
	console.log('Downloading translations...');

	page.evaluate(function () {
		downloadTranslationsFromCrowdin(true);
	});

	/*
	var n = 0;
	setInterval(function () {
		console.log('Taking screenshot ' + n);
		I.takeScreenshot(page, argv.screenshots, 'downloading_translations_' + n);
		n++;
	}, 2000);*/

	U.waitFor(page, '#translations-downloaded').then(function () {
		var ok = page.evaluate(function () {
			return $('#translations-downloaded').attr('data-success');
		});

		if (ok === '1')
		{
			console.log('OK!!');
			d.resolve();
		}
		else
		{
			d.reject('Could not download translations from Crowdin.');
		}
	}, d.reject);

	return d.promise;
};

var willGenerateEmails = function () {
	var d = new Deferred();

	page.evaluate(function () {
		generateEmails();
	});

	U.waitFor(page, '#feedback.success', 'any', 1000, 2000, 1800000).then(function () {
		I.takeScreenshot(page, argv.screenshots, 'emails_generated');
		d.resolve();
	}, d.reject);

	return d.promise;
};

var willBuildThePacks = function ()
{
	var d = new Deferred();

	page.evaluate(function () {
		$('#build_packs').click();
	});

	var packsPath = argv.shopRoot + '/modules/translatools/packs/all_packs.tar.gz';

	var dt = 1000;
	var elapsed = 0;
	var interval = setInterval(function () {
		elapsed += dt;
		if (fs.exists(packsPath))
		{
			clearInterval(interval);
			console.log('Got the file, waiting a bit to be sure it\'s complete...');
			setTimeout(function () {
				console.log('You\'ve got packs: ' + packsPath);
				fs.copy(packsPath, argv.movePacksTo);
				d.resolve(packsPath);
			}, 15000);
		}

		if (elapsed > 300000)
		{
			clearInterval(interval);
			d.reject('Gave up waiting for file: ' + packsPath);
		}
	}, dt);

	return d.promise;
};

page.onConsoleMessage = function(msg, lineNum, sourceId) {
    console.log('CONSOLE: ' + msg + ' (from line #' + lineNum + ' in "' + sourceId + '")');
};

page.onError = function(msg, trace) {
    var msgStack = ['ERROR: ' + msg];
    if (trace && trace.length) {
        msgStack.push('TRACE:');
        trace.forEach(function(t) {
            msgStack.push(' -> ' + t.file + ': ' + t.line + (t.function ? ' (in function "' + t.function + '")' : ''));
        });
    }
    console.error(msgStack.join('\n'));
};

page.onUrlChanged = function(targetUrl) {
    console.log('New URL: ' + targetUrl);
};

var modulesURL = null;

page.open(argv.url, function () {
	seq([
		I.willLogInBO(page, {
			email: argv.email || 'pub@prestashop.com',
			password: argv.password || '123456789'
		}),
		I.willClickMenuItem(page, 'AdminModules'),
		U.willWaitFor(page, 'a.action_module'),
		// We're on AdminModules
		function () {
			var d = new Deferred();
			d.resolve();
			modulesURL = page.url;
			console.log('AdminModules is at: ' + modulesURL);
			return d.promise;
		},
		// Go to translatools
		function () {
			var d = new Deferred();

			//window.location.href = $("a[href*='configure=translatools']").attr('href')
			var href = page.evaluate(function () {
				return $("a[href*='configure=translatools']").attr('href');
			});

			if (href)
			{
				page.evaluate(function (href) {
					window.location.href = href;
				}, href);
				seq([
					U.willWaitFor(page, '#translatability'),
					willSetApiSettings,
					willForceLiveTranslationMaybe,
					willInstallMissingModules,
					willExportSourcesToCrowdin,
					willRegenerateTheTranslations,
					willDownloadTranslations
				]).then(d.resolve, d.reject);
			}
			else
			{
				d.reject('It seems translatools is not installed.');
			}

			return d.promise;
		},
		// Go to AdminModules
		function () {
			page.evaluate(function (modulesURL) {
				window.location = modulesURL;
			}, modulesURL);
			var d = new Deferred();
			d.resolve();
			return d.promise;
		},
		U.willWaitFor(page, 'a.action_module'),
		// Generate the emails
		function () {
			var d = new Deferred();

			//window.location.href = $("a[href*='configure=translatools']").attr('href')
			var href = page.evaluate(function () {
				return $("a[href*='configure=emailgenerator']").attr('href');
			});

			if (href)
			{
				page.evaluate(function (href) {
					window.location.href = href;
				}, href);
				seq([
					U.willWaitFor(page, '#generate-all-emails'),
					willGenerateEmails
				]).then(d.resolve, d.reject);
			}
			else
			{
				d.reject('It seems emailgenerator is not installed.');
			}

			return d.promise;
		},
		function () {
			page.evaluate(function (modulesURL) {
				window.location = modulesURL;
			}, modulesURL);
			var d = new Deferred();
			d.resolve();
			return d.promise;
		},
		U.willWaitFor(page, 'a.action_module'),
		// Go back to translatools
		function () {
			var d = new Deferred();

			//window.location.href = $("a[href*='configure=translatools']").attr('href')
			var href = page.evaluate(function () {
				return $("a[href*='configure=translatools']").attr('href');
			});

			if (href)
			{
				page.evaluate(function (href) {
					window.location.href = href;
				}, href);
				seq([
					U.willWaitFor(page, '#translatability'),
					willBuildThePacks
				]).then(d.resolve, d.reject);
			}
			else
			{
				d.reject('It seems translatools is not installed.');
			}

			return d.promise;
		}
	]).then(function () {
		console.log('Good!');
		phantom.exit(components.errors.SUCCESS);
	}, function (error) {
		console.log('Bad!', error);
		phantom.exit(components.errors.UNSPECIFIED_ERROR);
	});
});