var express = require('express');
var http = require('http');
var path = require('path');
var fs = require('fs');
var httpProxy = require('http-proxy');
var clone = require('clone');
var xtend = require('xtend');

var util = require('./util');

var app = express();

// cloudcms app server support
var cloudcms = require("../index");

// let cloudcms pick up beanstalk params
cloudcms.beanstalk();

// set up modes
process.env.CLOUDCMS_APPSERVER_MODE = "development";

if (process.env.NODE_ENV === "production")
{
    process.env.CLOUDCMS_APPSERVER_MODE = "production";
}


// holds configuration settings
var SETTINGS = {
    "name": "Cloud CMS Application Server",
    "socketFunctions": [],
    "routeFunctions": [],
    "configureFunctions": {},
    "beforeFunctions": [],
    "afterFunctions": [],
    "virtualDriverConfig": {
    }
};

// default to using long polling?
// can assist for environments using non-sticky load balancer
// SETTINGS.socketTransports = ["xhr-polling"];

var exports = module.exports;

/**
 * Sets a configuration key/value.
 *
 * @param key
 * @param value
 */
exports.set = function(key, value)
{
    SETTINGS[key] = value;
};

/**
 * Gets a configuration key/value.
 *
 * @param key
 * @return {*}
 */
exports.get = function(key)
{
    return SETTINGS[key];
};

/**
 * Registers an express configuration function for a specific environment.
 *
 * @param env
 * @param fn
 */
exports.configure = function(env, fn)
{
    if (!SETTINGS.configureFunctions[env]) {
        SETTINGS.configureFunctions[env] = [];
    }

    SETTINGS.configureFunctions[env].push(fn);
};

/**
 * Registers a socket configuration function.
 *
 * @param fn
 */
exports.sockets = function(fn)
{
    SETTINGS.socketFunctions.push(fn);
};

/**
 * Registers a route configuration function.
 *
 * @param fn
 */
exports.routes = function(fn)
{
    SETTINGS.routeFunctions.push(fn);
};

/**
 * Registers a function to run before the server starts.
 *
 * @param fn
 */
var before = exports.before = function(fn)
{
    SETTINGS.beforeFunctions.push(fn);
};

/**
 * Registers a function to run after the server starts.
 *
 * @param fn
 */
var after = exports.after = function(fn)
{
    SETTINGS.afterFunctions.push(fn);
};

/**
 * Starts the Cloud CMS server.
 *
 * @param overrides optional config overrides
 * @param callback optional callback function
 */
exports.start = function(overrides, callback)
{
    if (typeof(overrides) === "function")
    {
        callback = overrides;
        overrides = null;
    }

    // create our master config
    var config = clone(SETTINGS);
    if (overrides) {
        config = xtend(config, overrides);
    }


    console.log("");
    console.log("Starting " + config.name);


    ////////////////////////////////////////////////////////////////////////////
    //
    // HTTP/HTTPS Proxy Server to Cloud CMS
    // Facilitates Cross-Domain communication between Browser and Cloud Server
    // This must appear at the top of the app.js file (ahead of config) for things to work
    //
    ////////////////////////////////////////////////////////////////////////////
    // START PROXY SERVER
    app.use("/proxy", httpProxy.createServer(function(req, res, proxy) {

        proxy.proxyRequest(req, res, {
            "host": process.env.GITANA_PROXY_HOST,
            "port": process.env.GITANA_PROXY_PORT,
            "xforward": true//,
            //"changeOrigin": true
        });
    }));
    // END PROXY SERVER



    ////////////////////////////////////////////////////////////////////////////
    //
    // BASE CONFIGURATION
    //
    // Configures NodeJS app server using handlebars templating engine
    // Runs on port 2999 by default
    //
    ////////////////////////////////////////////////////////////////////////////
    app.configure(function(){

        app.set('port', process.env.PORT || 2999);
        app.set('views', process.env.CLOUDCMS_APPSERVER_PUBLIC_PATH + "/../views");
        app.set('view engine', 'html'); // html file extension
        app.engine('html', require('hbs').__express);
        app.use(express.favicon());
        app.use(express.logger('dev'));

        //app.use(express.cookieParser());
        //app.use(express.cookieParser("secret"));

        // use the cloudcms body parser
        app.use(cloudcms.bodyParser());
        app.use(express.bodyParser());

        app.use(express.methodOverride());
        //app.use(express.session({ secret: 'secret', store: sessionStore }));

        // configure cloudcms app server command handing
        cloudcms.interceptors(app, true, config.virtualDriverConfig);

        app.use(app.router);
        app.use(express.errorHandler());

        // configure cloudcms app server handlers
        cloudcms.handlers(app, true);

    });



    ////////////////////////////////////////////////////////////////////////////
    //
    // CUSTOM EXPRESS APP CONFIGURE METHODS
    //
    ////////////////////////////////////////////////////////////////////////////
    for (var env in config.configureFunctions)
    {
        var functions = config.configureFunctions[env];
        if (functions)
        {
            for (var i = 0; i < functions.length; i++)
            {
                app.configure(env, functions[i]);
            }
        }
    }




    ////////////////////////////////////////////////////////////////////////////
    //
    // INITIALIZE THE SERVER
    //
    ////////////////////////////////////////////////////////////////////////////

    // CORE OBJECTS
    var server = http.createServer(app);
    var io = require("socket.io").listen(server);
    process.IO = io;

    // SET INITIAL VALUE FOR SERVER TIMESTAMP
    process.env.CLOUDCMS_APPSERVER_TIMESTAMP = new Date().getTime();

    // CUSTOM ROUTES
    for (var i = 0; i < config.routeFunctions.length; i++)
    {
        config.routeFunctions[i](app);
    }

    // BEFORE SERVER START
    util.series(config.beforeFunctions, [app], function(err) {

        // START THE APPLICATION SERVER
        server.listen(app.get('port'), function(){

            // AFTER SERVER START
            util.series(config.afterFunctions, [app], function(err) {

                // show standard info
                var url = "http://localhost:" + app.get('port') + "/";

                console.log(config.name + " started");
                console.log(" -> visit: " + url);
                console.log("");

                if (callback)
                {
                    callback(app);
                }

            });
        });

    });


    // INIT SOCKET.IO
    io.set('log level', 1);
    if (config.socketTransports && config.socketTransports.length > 0)
    {
        process.IO.set('transports', config.socketTransports);
    }
    if (config.socketLogLevel) {
        io.set('log level', config.socketLogLevel);
    }
    io.sockets.on("connection", function(socket) {

        socket.on("connect", function() {
            //console.log("SOCKET.IO HEARD CONNECT");
        });

        socket.on("disconnect", function() {
            //console.log("SOCKET.IO HEARD DISCONNECT");
        });

        // CUSTOM CONFIGURE SOCKET.IO
        for (var i = 0; i < config.socketFunctions.length; i++)
        {
            config.socketFunctions[i](socket);
        }
    });
};



////////////////////////////////////////////////////////////////////////////
//
// DEFAULT HANDLERS
//
////////////////////////////////////////////////////////////////////////////

// default before function
before(function(app, callback) {
    callback();
});

// default after function
after(function(app, callback) {
    callback();
});
