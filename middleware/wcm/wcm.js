var path = require('path');
var fs = require('fs');
var http = require('http');
var util = require("../../util/util");
var duster = require("../../duster/index");
var async = require("async");
var dependencyManager = require("./dependencies");

/**
 * WCM middleware.
 *
 * Serves up HTML pages based on WCM configuration.  Applies duster tag processing.
 *
 * @type {Function}
 */
exports = module.exports = function()
{
    // cache keys
    var WCM_PAGES_PRELOADING_FLAG = "wcmPagesPreloadingFlag";
    var WCM_PAGES = "wcmPages";

    // thread wait time if other thread preloading
    var WCM_PRELOAD_DEFER_WAIT_MS = 500;

    var isEmpty = function(thing)
    {
        return (typeof(thing) === "undefined") || (thing === null);
    };

    var startsWith = function(text, prefix) {
        return text.substr(0, prefix.length) === prefix;
    };

    var executeMatch = function(matcher, text)
    {
        // strip matcher from "/a/b/c" to "a/b/c"
        if (matcher && matcher.length > 0 && matcher.substring(0,1) === "/")
        {
            matcher = matcher.substring(1);
        }

        // strip text from "/a/b/c" to "a/b/c"
        if (text && text.length > 0 && text.substring(0,1) === "/")
        {
            text = text.substring(1);
        }

        var tokens = {};

        var printDebug = function()
        {
            if (process.env.NODE_ENV === "production") {
                // skip
            } else {
                console.log("Matched - pattern: " + matcher + ", text: " + text + ", tokens: " + JSON.stringify(tokens));
            }
        };

        var array1 = [];
        if (matcher)
        {
            array1 = matcher.split("/");
        }
        var array2 = [];
        if (text)
        {
            array2 = text.split("/");
        }

        // short cut - zero length matches
        if ((array1.length === 0) && (array2.length === 0))
        {
            printDebug();
            return tokens;
        }

        if (matcher)
        {
            // short cut - **
            if (matcher == "**")
            {
                // it's a match, pull out wildcard token
                tokens["**"] = text;
                printDebug();
                return tokens;
            }

            // if matcher has no wildcards or tokens...
            if ((matcher.indexOf("{") == -1) && (matcher.indexOf("*") == -1))
            {
                // if they're equal...
                if (matcher == text)
                {
                    // it's a match, no tokens
                    printDebug();
                    return tokens;
                }
            }
        }

        var pattern = null;
        var value = null;
        do
        {
            pattern = array1.shift();
            value = array2.shift();

            var patternEmpty = (isEmpty(pattern) || pattern === "");
            var valueEmpty = (isEmpty(value) || value === "");

            // if there are remaining pattern and value elements
            if (!patternEmpty && !valueEmpty)
            {
                if (pattern == "*")
                {
                    // wildcard - element matches
                }
                else if (pattern == "**")
                {
                    // wildcard - match everything else, so break out
                    tokens["**"] = "/" + [].concat(value, array2).join("/");
                    break;
                }
                else if (pattern.indexOf("{") > -1)
                {
                    var startIndex = pattern.indexOf("{");
                    var stopIndex = pattern.indexOf("}");

                    var prefix = null;
                    if (startIndex > 0)
                    {
                        prefix = pattern.substring(0, startIndex);
                    }

                    var suffix = null;
                    if (stopIndex < pattern.length - 1)
                    {
                        suffix = pattern.substring(stopIndex);
                    }

                    if (prefix)
                    {
                        value = value.substring(prefix.length);
                    }

                    if (suffix)
                    {
                        value = value.substring(0, value.length - suffix.length + 1);
                    }

                    var key = pattern.substring(startIndex + 1, stopIndex);

                    // URL decode the value
                    value = decodeURIComponent(value);

                    // assign to token collection
                    tokens[key] = value;
                }
                else
                {
                    // check for exact match
                    if (pattern == value)
                    {
                        // exact match
                    }
                    else
                    {
                        // not a match, thus fail
                        return null;
                    }
                }
            }
            else
            {
                // if we expected a pattern but empty value or we have a value but no pattern
                // then it is a mismatch
                if ((pattern && valueEmpty) || (patternEmpty && value))
                {
                    return null;
                }
            }
        }
        while (!isEmpty(pattern) && !isEmpty(value));

        printDebug();
        return tokens;
    };

    var findMatchingPage = function(pages, offsetPath, callback)
    {
        // walk through the routes and find one that matches this URI and method
        var discoveredTokensArray = [];
        var discoveredPages = [];
        var discoveredPageOffsetPaths = [];
        for (var pageOffsetPath in pages)
        {
            var matchedTokens = executeMatch(pageOffsetPath, offsetPath);
            if (matchedTokens)
            {
                discoveredPages.push(pages[pageOffsetPath]);
                discoveredTokensArray.push(matchedTokens);
                discoveredPageOffsetPaths.push(pageOffsetPath);
            }
        }

        // pick the closest page (overrides are sorted first)
        var discoveredPage = null;
        var discoveredTokens = null;
        var discoveredPageOffsetPath = null;
        if (discoveredPages.length > 0)
        {
            discoveredPage = discoveredPages[0];
            discoveredTokens = discoveredTokensArray[0];
            discoveredPageOffsetPath = discoveredPageOffsetPaths[0];
        }

        callback(null, discoveredPage, discoveredTokens, discoveredPageOffsetPath);
    };

    // assume 120 seconds (for development mode)
    var WCM_CACHE_TIMEOUT_SECONDS = 120;
    if (process.env.CLOUDCMS_APPSERVER_MODE === "production")
    {
        // for production, set to 24 hours
        WCM_CACHE_TIMEOUT_SECONDS = 60 * 60 * 24;
    }

    var preloadPages = function(req, callback)
    {
        var ensureInvalidate = function(callback) {

            // allow for forced invalidation via req param
            if (req.query["invalidate"]) {
                req.cache.remove(WCM_PAGES, function() {
                    callback();
                });
                return;
            }

            callback();
        };

        ensureInvalidate(function() {

            req.cache.read(WCM_PAGES, function (err, pages) {

                if (pages) {
                    callback(null, pages);
                    return;
                }

                // are these pages already being preloaded by another thread
                req.cache.read(WCM_PAGES_PRELOADING_FLAG, function(err, preloading) {

                    if (preloading)
                    {
                        req.log("Another thread is currently preloading pages, waiting " + WCM_PRELOAD_DEFER_WAIT_MS + " ms");
                        // wait a while and try again
                        setTimeout(function() {
                            preloadPages(req, callback);
                        }, WCM_PRELOAD_DEFER_WAIT_MS);

                        return;
                    }


                    // mark that we are preloading
                    // this prevents other "threads" from entering here and preloading at the same time
                    // we set this marker for 30 seconds max
                    req.cache.write(WCM_PAGES_PRELOADING_FLAG, true, 30);

                    req.log("Loading Web Pages into cache");

                    // build out pages
                    pages = {};

                    var errorHandler = function (err) {

                        //  mark that we're finished preloading
                        req.cache.remove(WCM_PAGES_PRELOADING_FLAG, function() {
                            // this eventually finishes but we don't care to wait
                        });

                        req.log("Error while loading web pages: " + JSON.stringify(err));

                        callback(err);
                    };

                    // load all wcm pages from the server
                    req.branch(function(err, branch) {

                        branch.trap(function(err) {

                            //  mark that we're finished preloading
                            req.cache.remove(WCM_PAGES_PRELOADING_FLAG, function() {
                                // this eventually finishes but we don't care to wait
                            });

                            errorHandler(err);
                            return;
                        }).then(function () {

                            this.queryNodes({
                                "_type": "wcm:page"
                            }, {
                                "limit": -1
                            }).each(function () {

                                // THIS = wcm:page
                                var page = this;

                                // if page has a template
                                if (page.template)
                                {
                                    if (page.uris)
                                    {
                                        // merge into our pages collection
                                        for (var i = 0; i < page.uris.length; i++)
                                        {
                                            pages[page.uris[i]] = page;
                                        }
                                    }

                                    // is the template a GUID or a path to the template file?
                                    if (page.template.indexOf("/") > -1)
                                    {
                                        page.templatePath = page.template;
                                    }
                                    else
                                    {
                                        // load the template
                                        this.subchain(branch).readNode(page.template).then(function () {

                                            // THIS = wcm:template
                                            var template = this;
                                            page.templatePath = template.path;
                                        });
                                    }
                                }
                            })

                        }).then(function () {

                            for (var uri in pages) {
                                req.log("Loaded Web Page -> " + uri);
                            }

                            req.cache.write(WCM_PAGES, pages, WCM_CACHE_TIMEOUT_SECONDS);

                            //  mark that we're finished preloading
                            req.cache.remove(WCM_PAGES_PRELOADING_FLAG, function() {
                                // this eventually finishes but we don't care to wait
                            });

                            callback(null, pages);
                        });
                    });
                });
            });
        });
    };

    //////////////////////////////////////////////////////////////////////////////////////////////////////////////
    //
    // PAGE CACHE (WITH DEPENDENCIES)
    //
    //////////////////////////////////////////////////////////////////////////////////////////////////////////////


    /**
     * Determines whether to use the page cache.  We use this cache if we're instructed to and if we're in
     * production model.
     *
     * @returns {boolean}
     */
    var isPageCacheEnabled = function()
    {
        var enabled = false;

        if (process.configuration.wcm && process.configuration.wcm.enabled)
        {
            if (process.env.FORCE_CLOUDCMS_WCM_PAGE_CACHE === "true")
            {
                process.configuration.wcm.cache = true;
            }
            else if (typeof(process.env.FORCE_CLOUDCMS_WCM_PAGE_CACHE) === "boolean" && process.env.FORCE_CLOUDCMS_WCM_PAGE_CACHE)
            {
                process.configuration.wcm.cache = true;
            }

            enabled = process.configuration.wcm.cache;
        }

        if (process.env.CLOUDCMS_APPSERVER_MODE !== "production")
        {
            enabled = false;
        }

        return enabled;
    };

    var handleCachePageWrite = function(req, descriptor, dependencies, text, callback)
    {
        if (!isPageCacheEnabled())
        {
            callback();
            return;
        }

        var contentStore = req.stores.content;

        // the descriptor contains "path", "params" and "headers".  We use this to generate a unique key.
        // essentially this is a hash and acts as the page cache key
        var pageCacheKey = util.generatePageCacheKey(descriptor);

        // write page cache entry
        var pageFilePath = path.join("wcm", "repositories", req.repositoryId, "branches", req.branchId, "pages", pageCacheKey, "page.html");
        contentStore.writeFile(pageFilePath, text, function(err) {

            if (err)
            {
                callback(err);
                return;
            }

            if (dependencies)
            {
                dependencyManager.add(req, descriptor, dependencies, function (err) {
                    callback(err);
                });
            }
            else
            {
                callback();
            }
        });
    };

    var handleCachePageRead = function(req, descriptor, callback)
    {
        if (!isPageCacheEnabled())
        {
            callback();
            return;
        }

        var contentStore = req.stores.content;

        // the descriptor contains "path", "params" and "headers".  We use this to generate a unique key.
        // essentially this is a hash and acts as the page cache key
        var pageCacheKey = util.generatePageCacheKey(descriptor);

        var pageFilePath = path.join("wcm", "repositories", req.repositoryId, "branches", req.branchId, "pages", pageCacheKey, "page.html");
        util.safeReadStream(contentStore, pageFilePath, function(err, stream) {
            callback(err, stream);
        });
    };

    /*
    var handleCachePageInvalidate = function(req, uri, callback)
    {
        var contentStore = req.stores.content;

        var pageFilePath = path.join("wcm", "repositories", req.repositoryId, "branches", req.branchId, "pages", uri, "page.html");
        contentStore.existsFile(pageFilePath, function(exists) {

            if (!exists) {
                callback();
                return;
            }

            // delete the page file
            contentStore.deleteFile(pageFilePath, function (err) {

                // invalidate all page dependencies
                dependenciesService.remove(req, uri, function (err) {
                    callback(err);
                });
            });
        });
    };
    */

    /*
    var handleCacheDependencyInvalidate = function(req, key, value, callback)
    {
        var contentStore = req.stores.content;

        // read page json
        var dependencyDirectoryPath = path.join("wcm", "applications", req.applicationId, "dependencies", key, value);
        contentStore.listFiles(dependencyDirectoryPath, function(err, filenames) {

            var fns = [];
            for (var i = 0; i < filenames.length; i++)
            {
                var fn = function(req, dependencyDirectoryPath, filename) {
                    return function(done) {

                        var dependencyFilePath = path.join(dependencyDirectoryPath, filename);
                        contentStore.existsFile(dependencyFilePath, function(exists) {

                            if (!exists) {
                                done();
                                return;
                            }

                            contentStore.readFile(dependencyFilePath, function (err, data) {

                                if (err) {
                                    done();
                                    return;
                                }

                                try
                                {
                                    var json = JSON.parse("" + data);
                                    var uri = json.uri;

                                    // remove the dependency entry
                                    contentStore.deleteFile(dependencyFilePath, function(err) {

                                        // invalidate the page
                                        handleCachePageInvalidate(req, uri, function (err) {
                                            done();
                                        });
                                    });
                                }
                                catch (e) {
                                    // oh well
                                }
                            });
                        });

                    };
                }(req, dependencyDirectoryPath, filenames[i]);
                fns.push(fn);
            }
        });
    };
    */

    var bindSubscriptions = function()
    {
        if (process.broadcast)
        {
            process.broadcast.subscribe("node_invalidation", function (message) {

                var nodeId = message.nodeId;
                var branchId = message.branchId;
                var repositoryId = message.repositoryId;
                var ref = message.ref;

                console.log("WCM middleware invalidated: " + ref);

                if (isPageCacheEnabled())
                {
                    // TODO
                }

            });
        }
    };




    //////////////////////////////////////////////////////////////////////////////////////////////////////////////
    //
    // RESULTING OBJECT
    //
    //////////////////////////////////////////////////////////////////////////////////////////////////////////////

    var r = {};

    /**
     * Provides WCM page retrieval from Cloud CMS.
     *
     * @param configuration
     * @return {Function}
     */
    r.wcmHandler = function()
    {
        // bind listeners for broadcast events
        bindSubscriptions();

        // wcm handler
        return util.createHandler("wcm", function(req, res, next, configuation, stores) {

            if (!req.gitana)
            {
                next();
                return;
            }

            var webStore = stores.web;

            // ensures that the WCM PAGES cache is preloaded for the current branch
            // pages must be loaded ahead of time so that matching can be performed
            preloadPages(req, function(err, pages) {

                if (err)
                {
                    next();
                    return;
                }

                var offsetPath = req.path;

                // find a page for this path
                // this looks at wcm:page urls and finds a best fit, extracting tokens
                findMatchingPage(pages, offsetPath, function(err, page, tokens, matchingPath) {

                    if (err)
                    {
                        req.log("An error occurred while attempting to match path: " + offsetPath);

                        next();
                        return;
                    }

                    // if no extracted tokens, assume empty set
                    if (!tokens) {
                        tokens = {};
                    }

                    // if we found a page, then we either need to serve back from cache or run dust over it
                    // after dust is run over it, we can stuff it into cache for the next request to benefit from
                    if (page)
                    {
                        var host = req.domainHost;
                        if ("localhost" === host) {
                            host = req.headers["host"];
                        }

                        var descriptor = {
                            "url": req.protocol + "://" + host + offsetPath,
                            "host": host,
                            "protocol": req.protocol,
                            "path": offsetPath,
                            "params": req.query,
                            "headers": req.headers,
                            "matchingTokens": tokens,
                            "matchingPath": matchingPath,
                            "matchingUrl": req.protocol + "://" + host + matchingPath,
                            "matchingPageId": page._doc,
                            "matchingPageTitle": page.title ? page.title : page._doc
                        };

                        // is this already in cache?
                        handleCachePageRead(req, descriptor, function(err, readStream) {

                            if (!err && readStream)
                            {
                                // yes, we found it in cache, so we'll simply pipe it back from disk
                                req.log("WCM Page Cache Hit: " + offsetPath);
                                res.status(200);
                                readStream.pipe(res);
                                return;
                            }

                            // otherwise, we need to run dust!

                            var runDust = function()
                            {
                                // TODO: block here in case another thread is trying to dust this page at the same time?

                                if (!req.helpers) {
                                    req.helpers = {};
                                }
                                req.helpers.page = page;

                                // build the model
                                var model = {
                                    "page": {},
                                    "template": {
                                        "path": page.templatePath
                                    },
                                    "request": {
                                        "tokens": tokens,
                                        "matchingPath": matchingPath
                                    }
                                };

                                // page keys to copy
                                for (var k in page) {
                                    if (k == "templatePath") {
                                    } else if (k.indexOf("_") === 0) {
                                    } else {
                                        model.page[k] = page[k];
                                    }
                                }

                                // set _doc and id (equivalent)
                                model.page._doc = model.page.id = page._doc;

                                // dust it up
                                duster.execute(req, webStore, page.templatePath, model, function (err, text, dependencies) {

                                    if (err)
                                    {
                                        // something screwed up during the dust execution
                                        // it might be a bad template
                                        req.log("Failed to process dust template: " + page.templatePath + " for model: " + JSON.stringify(model, null, "  "));

                                        res.status(500);
                                        res.send(err);
                                        return;
                                    }

                                    // we now have the result (text) and the dependencies that this page flagged (dependencies)
                                    // use these to write to the page cache
                                    handleCachePageWrite(req, descriptor, dependencies, text, function(err) {
                                        res.status(200);
                                        res.send(text);
                                    });

                                });
                            };
                            runDust();
                        });
                    }
                    else
                    {
                        next();
                    }

                });
            });
        });
    };

    return r;
}();

