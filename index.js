(function () {
	'use strict';

	var system		= require('system');
	var argv        = require('minimist')(system.args);
	var ncp         = require('ncp').ncp;
	var Deferred    = require('promised-io/promise').Deferred;
	var seq			= require('promised-io/promise').seq;
	var fs          = require('fs.extra');
	var path        = require('path');
	var portfinder  = require('portfinder');
	var spawn       = require('child_process').spawn;
	var exec        = require('child_process').exec;
	var mysql       = require('mysql');
	var git         = require('./vendor/phantomshop/lib/git.js');
	var ghosts      = require('./vendor/phantomshop/lib/ghosts.js');
	var components  = require('./vendor/phantomshop/ghosts/tools/components.js');
	var decompress  = require('decompress');
	var nodemailer  = require('nodemailer');

	var config      = require('./config.js');

	var sourceFolder = path.join(__dirname, 'versions', argv.version);
	var crowdinVersionSpecifier = path.join(sourceFolder, '.crowdin_version');

	if (!argv.crowdinVersion && fs.existsSync(crowdinVersionSpecifier))
	{
		argv.crowdinVersion = fs.readFileSync(crowdinVersionSpecifier, {encoding: 'UTF-8'}).trim();
	}
	
	var smtpTransport = nodemailer.createTransport('SMTP', {
		service: 'Gmail',
		auth: {
			user: config.gmailUser,
			pass: config.gmailPassword
		}
	});

	var sendMail = function (error, then)
	{
		var text = error ? error : 'Seems it went fine!';
		var subject = error ? 'Language packs publication failed for ' + argv.version : '(Successfully?) Published language packs for ' + argv.version;

		var mailOptions = {
			from: 'FMDJ <fmdj@prestashop.com>',
			to: 'fmdj@prestashop.com, translation@prestashop.com',
			subject: subject,
			text: text,
			html: text
		};

		smtpTransport.sendMail(mailOptions, function(error, response){
			if(error){
				console.log(error);
				then();
			}else{
				console.log("Email sent: " + response.message);
				then();
			}
		});
	};

	if (!argv.version)
	{
		console.log('Please specify a version (e.g. --version 1.6.0.5)');
		process.exit(1);
	}

	function prefixify(str)
	{
		return str.replace(/\W+/g, '_') + '_';
	}

	var shopRoot = null;
	var backOfficeURL = null;
	var installerURL = null;

	var movePacksToDir = path.join(__dirname, 'packs', argv.version);
	var movePacksTo = path.join(movePacksToDir, 'all_packs.tar.gz');

	if (fs.existsSync(movePacksToDir))
	{
		fs.rmrfSync(movePacksToDir);
		fs.mkdirSync(movePacksToDir);
	}

	var updateGitIfNeeded = function () {
		var d = new Deferred();

		if (fs.existsSync(path.join(sourceFolder, '.git')))
		{
			spawn('git', ['pull'], {cwd: sourceFolder, stdio: 'ignore'}).on('exit', function (code) {
				if (code === 0)
				{
					spawn('git', ['submodule', 'foreach', 'git', 'pull'], {cwd: sourceFolder, stdio: 'ignore'}).on('exit', function (code) {
						if (code === 0)
						{
							console.log('Pulled main repo and submodules in: ' + sourceFolder);
							d.resolve();
						}
						else
						{
							d.reject('Could not run git submodule foreach git pull.')
						}
					});
				}
				else
				{
					d.reject('Could not run git pull.')
				}
			})
		}

		return d.promise;
	};

	var copyFiles = function () {
		var d = new Deferred();
		var source = path.join(__dirname, 'versions', argv.version);
		var dest = path.join(config.sandboxDir, argv.version);
		shopRoot = dest;
		if (fs.existsSync(dest))
		{
			fs.rmrfSync(dest);
		}
		ncp(source, dest, function (err) {
			if (err)
			{
				d.reject(err);
			}
			else
			{
				d.resolve(dest);
			}
		});
		return d.promise;
	};

	var prepareTheShop = function (dir) {
		var d = new Deferred();

		if (fs.existsSync(path.join(dir, 'admin')))
		{
			if (undefined !== fs.renameSync(path.join(dir, 'admin'), path.join(dir, 'admin-dev')))
			{
				console.log(path.join(dir, 'admin'), path.join(dir, 'admin-dev'));
				d.reject('Could not rename admin to admin-dev.');
			}
		}
		if (fs.existsSync(path.join(dir, 'install')))
		{
			if (undefined !== fs.renameSync(path.join(dir, 'install'), path.join(dir, 'install-dev')))
			{
				d.reject('Could not rename install to install-dev.');
			}
		}

		portfinder.getPort(function (error, port) {
			if (error)
			{
				d.reject('Could not find an open port: ' + error);
			}
			else
			{
				d.resolve({port: port, path: dir});
			}
		});


		return d.promise;
	};

	var serverProcess = null;

	var startTheServer = function (params) {
		var d = new Deferred();
		console.log('Starting server on localhost:' + params.port + ' in ' + params.path);
		var args = ['-S', 'localhost:' + params.port, '-t', params.path];

		serverProcess = spawn(config.phpExecutable || 'php', args, {stdio: 'ignore'});

		backOfficeURL = 'http://localhost:' + params.port + '/admin-dev/index.php';
		installerURL = 'http://localhost:' + params.port + '/install-dev/index.php';

		setTimeout(function () {
			d.resolve();
		}, 2000);

		return d.promise;
	};

	var cleanTheDatabase = function (url){
		var d = new Deferred();

		var connection = mysql.createConnection({
			host: 'localhost',
			user: config.mysqlUser,
			password: config.mysqPassword,
			database: config.mysqlDatabase
		});

		connection.connect();

		var promiseDrop = function (tableName)
		{
			return function ()
			{
				var d = new Deferred();

				connection.query('DROP TABLE ' + tableName, function (error) {
					if (error)
					{
						d.reject('Could not drop table: ' + tableName);
					}
					else
					{
						d.resolve();
					}
				});

				return d.promise;
			};
		};

		var sql = 'SHOW TABLES LIKE \'' + prefixify(argv.version).replace(/_/g, '\\_') + '%\';';
		connection.query(sql, function (error, rows, fields) {
			if (error)
			{
				d.reject(error);
			}
			else
			{
				var dropTables = [];
				for (var i = 0; i < rows.length; i++)
				{
					var tableName = rows[i][fields[0].name];
					dropTables.push(promiseDrop(tableName));
				}
				seq(dropTables).then(function () {
					d.resolve(url);
				}, d.reject);
			}
		});

		return d.promise;
	};

	var installTheShop = function () {
		var d = new Deferred();

		var installerScript = path.join(__dirname, 'vendor', 'phantomshop', 'ghosts', 'install.js');

		var args = [installerScript,
			'--url', installerURL,
			'--screenshots', path.join(__dirname, 'screenshots'),
			'--tablesPrefix', prefixify(argv.version),
			'--mysqlUser', config.mysqlUser,
			'--mysqPassword', config.mysqPassword,
			'--mysqlDatabase', config.mysqlDatabase,
			'--email', 'pub@prestashop.com',
			'--password', '123456789'
		];

		
		args.push('--language');
		args.push('en');
		
		args.push('--countryCode');
		args.push('us');

		console.log('running: phantomjs ' + args.join(' '));

		var child = spawn('phantomjs', args, {stdio: 'inherit'});
		child.on('exit', function (code) {
			if (code === 0)
			{
				d.resolve(backOfficeURL);
			}
			else
			{
				d.reject('The installation failed for some reason!');
			}
		});

		return d.promise;
	};

	var willCloneModule = function (moduleName, repo, branch) {
		return function () {
			console.log(shopRoot, moduleName, repo, branch);
			return git.clone(path.join(shopRoot, 'modules', moduleName), repo, branch);
		};
	};

	var willInstallModule = function (name) {
		return function () {
			var d = new Deferred();

			var installerScript = path.join(__dirname, 'vendor', 'phantomshop', 'ghosts', 'install_module.js');

			var args = [installerScript,
				'--url', backOfficeURL,
				//'--screenshots', path.join(__dirname, 'screenshots'),
				'--module', name
			];

			console.log('running: phantomjs ' + args.join(' '));

			var child = spawn('phantomjs', args, {stdio: 'inherit'});
			child.on('exit', function (code) {
				if (code === 0)
				{
					d.resolve();
				}
				else
				{
					d.reject('Could not install module: ' + name);
				}
			});

			return d.promise;
		};
	};

	var makeThePacks = function ()
	{
		return ghosts.run(__dirname + '/ghosts/crowdin_agd.js', {
			url: backOfficeURL,
			shopRoot: shopRoot,
			screenshots: __dirname + '/screenshots',
			movePacksTo: movePacksTo,
			projectIdentifier: config.projectIdentifier,
			crowdinAPIKey: config.crowdinAPIKey,
			crowdinVersion: argv.crowdinVersion || argv.version
		});
	};

	var extractThePacks = function ()
	{
		var d = new Deferred();

		var src = fs.createReadStream(movePacksTo);
		var dest = decompress({ext: '.tar.gz', path: movePacksToDir});
		
		dest.on('end', function () {
			fs.unlinkSync(movePacksTo);
			d.resolve();
		});
		
		dest.on('error', function () {
			d.reject('Could not extract: ' + movePacksTo);
		});

		src.pipe(dest);

		return d.promise;
	};

	var testThePacks = function () {
		console.log('Will now test the packs...');
		var d = new Deferred();

		exec('nodejs install_translation_packs --packsDir ' + path.join('packs', argv.version) + ' --url ' + backOfficeURL, function (error, stdout) {
			if (error)
			{
				console.log(stdout);
				d.reject('Could not install one of the packs :/');
			}
			else
			{
				d.resolve();
			}
		});

		return d.promise;
	};

	var publishThePacks = function () {
		console.log('Will now publish the packs...');

		var packsDir = path.join('packs', argv.version);

		var promises = fs.readdirSync(packsDir).map(function (entry) {
			if (/\.gzip$/.exec(entry))
			{
				var packPath = path.join(packsDir, entry);

				console.log('Preparing to publish pack: ' + packPath);

				return function () {
					var d = new Deferred();
					var cmd = 'publish_pack.rb ' + packPath + ' ' + argv.version;

					console.log('Running: ' + cmd);

					exec(cmd, function (error, stdout) {
						console.log(stdout);
						if (error)
						{
							d.reject(error);
						}
						else
						{
							d.resolve();
						}
					});

					return d.promise;
				};
			}
		});

		console.log('CROSS YOUR FINGERS, BRACE FOR IMPACT');

		return seq(promises);
	};

	var quit = function (code) {
		if (serverProcess)
		{
			serverProcess.kill();
		}
		process.exit(code);
	};

	seq([
		updateGitIfNeeded,
		copyFiles,
		prepareTheShop,
		startTheServer,
		cleanTheDatabase,
		installTheShop,
		willCloneModule('emailgenerator', 'https://github.com/djfm/emailgenerator', 'master'),
		willCloneModule('translatools', 'https://github.com/djfm/translatools', 'development'),
		components.glue.willDelay(5000), // dunno why, but if we don't wait the server hangs
		willInstallModule('emailgenerator'),
		willInstallModule('translatools'),
		components.glue.willDelay(10000), // let crowdin rest, don't make him think we're attacking,
		makeThePacks,
		extractThePacks,
		copyFiles,
		prepareTheShop,
		cleanTheDatabase,
		installTheShop,
		testThePacks,
		publishThePacks
	]).then(function (params) {
		console.log('Success!? -- packs generated and published for: ' + argv.version);
		sendMail(null, function () {
			quit(0);
		});
	}, function (error) {
		console.log('Something bad happened: ' + error);
		sendMail(error, function () {
			quit(1);
		});
	});

})();