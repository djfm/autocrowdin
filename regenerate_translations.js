var system		= require('system');
var	argv		= require('minimist')(system.args);
var request     = require('request');

if (!argv.url)
{
	console.log('Please provide URL! (--url some_url)');
	process.exit(42);
}

request(argv.url, function (error, response, body) {
	if (error)
	{
		console.log(error);
		process.exit(42);
	}
	else
	{
		body = JSON.parse(body);

		if (body.success)
		{
			process.exit(body.success.status === 'built' ? 0 : 1);
		}
		else
		{
			process.exit(42);
		}
	}
});

