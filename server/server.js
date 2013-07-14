// TODO start checking auth token, test it, remove it from json data
// TODO make different logger
// TODO decide on timestamp/id/hash precision
// TODO add a conversationID
//
// TODO crap! you have to sync ALL the events, or no events.. let's just make a nice rest api and do the work on the server.
//
// TODO try mongo explain https://github.com/mongodb/node-mongodb-native/blob/master/examples/queries.js#L90

console.log('redisAuth url ' +process.env.REDISTOGO_URL);
console.log('redisCloud url ' +process.env.REDISCLOUD_URL);

//require('nodefly').profile(
    //process.env.NODEFLY_APPLICATION_KEY,
    //[process.env.APPLICATION_NAME,'Heroku']
//);

var http = require('http'),
    express = require('express'),
    app = express(),
    pg = require('pg').native, //.native, // native provides ssl (needed for dev laptop to access) http://stackoverflow.com/questions/10279965/authentication-error-when-connecting-to-heroku-postgresql-databa
    mongo = require('mongodb'), MongoServer = mongo.Server, MongoDb = mongo.Db, ObjectId = mongo.ObjectID,
    async = require('async'),
    fs = require('fs'),
    url = require('url'),
    path = require('path'),
    bcrypt = require('bcrypt'),
    crypto = require('crypto'),
    _ = require('underscore');

app.disable('x-powered-by'); // save a whale

var AUTH_FAILED = 'auth failed';
var ALLOW_ANON = true;

var redisForAuth;
if (process.env.REDISTOGO_URL) {
    var rtg   = url.parse(process.env.REDISTOGO_URL);
    var redisForAuth = require("redis").createClient(rtg.port, rtg.hostname);
    redisForAuth.auth(rtg.auth.split(":")[1]);
} else {
    redisForAuth = require('redis').createClient();
}

var redisForMathResults;
if (process.env.REDISCLOUD_URL) {
    var rc   = url.parse(process.env.REDISCLOUD_URL);
    var redisForMathResults= require("redis").createClient(rc.port, rc.hostname);
    redisForMathResults.auth(rc.auth.split(":")[1]);
} else {
    redisForMathResults = require('redis').createClient();
}


function orderLike(itemsToBeReordered, itemsThatHaveTheRightOrder, fieldName) {
    var i;
    // identity field -> item
    var items = {};
    for (i = 0; i < itemsToBeReordered.length; i++) {
        items[itemsToBeReordered[i][fieldName]] = itemsToBeReordered[i];
    }
    var dest = [];
    for (i = 0; i < itemsThatHaveTheRightOrder.length; i++) {
        dest.push(items[itemsThatHaveTheRightOrder[i][fieldName]]);
    }
    return dest;
}


// Eventually, the plan is to support a larger number-space by using some lowercase letters.
// Waiting to implement that since there's cognitive overhead with mapping the IDs to/from
// letters/numbers.
// Just using digits [2-9] to start with. Omitting 0 and 1 since they can be confused with
// letters once we start using letters.
// This should give us roughly 8^8 = 16777216 conversations before we have to add letters.
var ReadableIds = (function() {
    function rand(a) {
        return _.random(a.length);
    }
    // no 1 (looks like l)
    // no 0 (looks like 0)
    var numbers8 = "23456789".split(""); 

    // should fit within 32 bits
    function generateConversationId() {
       return [
            rand(numbers8),
            rand(numbers8),
            rand(numbers8),
            rand(numbers8),
            rand(numbers8),
            rand(numbers8),
            rand(numbers8),
            rand(numbers8)
        ].join('');
    }
    return {
        generateConversationId: generateConversationId,
    };
}());


// Connect to a mongo database via URI
// With the MongoLab addon the MONGOLAB_URI config variable is added to your
// Heroku environment.  It can be accessed as process.env.MONGOLAB_URI

console.log(process.env.MONGOLAB_URI);

function makeSessionToken() {
    // These can probably be shortened at some point.
    return crypto.randomBytes(32).toString('base64').replace(/[^A-Za-z0-9]/g,"").substr(0, 20);
}

function getUserInfoForSessionToken(sessionToken, res, cb) {
    redisForAuth.get(sessionToken, function(errGetToken, replies) {
        if (errGetToken) { console.error("token_fetch_error"); cb(500); return; }
        if (!replies) { console.error("token_expired_or_missing"); cb(403); return; }
        cb(null, {u: replies});
    });
}

function startSession(userID, cb) {
    var sessionToken = makeSessionToken();
    //console.log('startSession: token will be: ' + sessionToken);
    console.log('startSession');
    redisForAuth.set(sessionToken, userID, function(errSetToken, repliesSetToken) {
        if (errSetToken) { cb(errSetToken); return }
        console.log('startSession: token set.');
        redisForAuth.expire(sessionToken, 3*31*24*60*60, function(errSetTokenExpire, repliesExpire) {
            if (errSetTokenExpire) { cb(errSetTokenExpire); return; }
            console.log('startSession: token will expire.');
            cb(null, sessionToken);
        });
    });
}

function endSession(sessionToken, cb) {
    redisForAuth.del(sessionToken, function(errDelToken, repliesSetToken) {
        if (errDelToken) { cb(errDelToken); return }
        cb(null);
    });
}

/*
console.log('b4 starting session');
var testSession = function(userID) {
    console.log('starting session');
    startSession(userID, function(err, token) {
        if (err) {
            console.error('startSession failed with error: ' + err);
            return;
        }
        console.log('started session with token: ' + token);
        getUserInfoForSessionToken(token, function(err, fetchedUserInfo) {
            if (err) { console.error('getUserInfoForSessionToken failed with error: ' + err); return; }
            console.log(userID, fetchedUserInfo.u);
            var status = userID === fetchedUserInfo.u ? "sessions work" : "sessions broken";
            console.log(status);
        });
    });
};
testSession("12345ADFHSADFJKASHDF");
*/


//var mongoServer = new MongoServer(process.env.MONGOLAB_URI, 37977, {auto_reconnect: true});
//var db = new MongoDb('exampleDb', mongoServer, {safe: true});
function connectToMongo(callback) {
mongo.connect(process.env.MONGOLAB_URI, {
    server: {
        auto_reconnect: true
    },
    db: {
        safe: true
    }
}, function(err, db) {
    if(err) {
        console.error('mongo failed to init');
        console.error(err);
        process.exit(1);
    }

    db.collection('users', function(err, collectionOfUsers) {
    db.collection('events', function(err, collection) {
    db.collection('stimuli', function(err, collectionOfStimuli) {
    db.collection('pcaResults', function(err, collectionOfPcaResults) {
        callback(null, {
            mongoCollectionOfEvents: collection,
            mongoCollectionOfUsers: collectionOfUsers,
            mongoCollectionOfStimuli: collectionOfStimuli,
            mongoCollectionOfPcaResults: collectionOfPcaResults,
        });
    });
    });
    });
    });
});
}

function connectToPostgres(callback) {
    var connectionString = process.env.DATABASE_URL || 'postgres://localhost:5432/dailyjs';
    var client = new pg.Client(connectionString);

    client.connect();
    callback(null, {
        client: client
    });
}

function postgresQuery() {
    query = client.query('SELECT * FROM mytable');
    query.on('end', function() { client.end(); });
}


// input token from body or query, and populate req.body.u with userid.
function auth(req, res, next) {
    var token = req.body.token;
    if (!token) { next(400); return; }
    if (req.body.u) { next(400); return; } // shouldn't be in the post
    getUserInfoForSessionToken(token, res, function(err, fetchedUserInfo) {
        if (err) { next(err); return;}
         // don't want to pass the token around
        if (req.body) delete req.body.token;
        if (req.query) delete req.query.token;

        req.body.u = fetchedUserInfo.u;
        next(null);
    });
}

// Consolidate query/body items in one place so other middleware has one place to look.
function moveToBody(req, res, next) {
    if (req.query) {
        req.body = req.body || {};
        _.extend(req.body, req.query);
    }
    next();
}

function makeHash(ary) {
    return _.object(ary, ary.map(function(){return 1;}));
}

String.prototype.hashCode = function(){
    var hash = 0, i, char;
    if (this.length == 0) return hash;
    for (i = 0; i < this.length; i++) {
        char = this.charCodeAt(i);
        hash = ((hash<<5)-hash)+char;
        hash = hash & hash; // Convert to 32bit integer
    }
    return hash;
};

function fail(res, code, err, httpCode) {
    console.error(code, err);
    res.writeHead(httpCode || 500);
    res.end(err);
}


function initializePolisAPI(err, args) {
var mongoParams = args[0];
var postgresParams = args[1];

if (err) {
    console.error("failed to init db connections");
    console.error(err);
    return;
}
var collection = mongoParams.mongoCollectionOfEvents;
var collectionOfUsers = mongoParams.mongoCollectionOfUsers;
var collectionOfStimuli = mongoParams.mongoCollectionOfStimuli;
var collectionOfPcaResults = mongoParams.mongoCollectionOfPcaResults;

var client = postgresParams.client;

var polisTypes = {
    reactions: {
        push: 1,
        pull: -1,
        see: 0,
    },
};

var objectIdFields = ["_id", "u", "to"];
var not_objectIdFields = ["s"];
function checkFields(ev) {
    for (k in ev) {
        if ("string" === typeof ev[k] && objectIdFields.indexOf(k) >= 0) {
            ev[k] = ObjectId(ev[k]);
        }
        // check if it's an ObjectId, but shouldn't be
        if (ev[k].getTimestamp && not_objectIdFields.indexOf(k) >= 0) {
            console.error("field should not be wrapped in ObjectId: " + k);
            process.exit(1);
        }
    }
}
// helper for migrating off of mongo style identifiers
function match(key, s) {
    var variants = [{}];
    variants[0][key] = s;
    if (s.length === 24) {
        variants.push({});
        variants[1][key] = ObjectId(s);
    }
    return {$or: variants};
}

    function reactionsPost(res, pid, cid, events) {
        if (!events.length) { fail(res, 324234327, err); return; }
        events.forEach(function(ev){
            var oid = events.oid;
            var vote = ev.vote;
            if ("undefined" === typeof polisTypes.reactions[vote]) { fail(res, 2394626, "polis_err_bad_vote_type", 400); return; }
            client.query("INSERT INTO votes (cid, pid, oid, vote, created) VALUES ($1, $2, $3, $4, default);", [cid, pid, oid, vote], function(err, result) {
                if (err) { fail(res, 324234324, err); return; }
                res.end();  // TODO don't stop after the first one, map the inserts to deferreds.
            });
        });
    }

    function reactionsGet(res, params) {
        var cid = params.cid;
        var pid = params.pid;
        client.query("SELECT * FROM votes WHERE cid = ($1) && pid = ($2);", [cid, pid], function(err, docs) {
            if (err) { fail(res, 234234326, err); return; }
            res.json(docs);
        });
    } // End reactionsGet

    // TODO consider moving to a 
    function writeDefaultHead(req, res) {
        res.setHeader({
            'Content-Type': 'application/json',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
        //    'Access-Control-Allow-Origin': '*',
        //    'Access-Control-Allow-Credentials': 'true'
        });
    }

    //app.use(writeDefaultHead);
    app.use(express.logger());

app.get("/v2/math/pca",
    moveToBody,
    function(req, res) {
        var stimulus = req.body.s;
        var lastServerToken = req.body.lastServerToken || "000000000000000000000000";
        collectionOfPcaResults.find({$and :[
            match("s", stimulus),
            {lastServerToken: {$gt: ObjectId(lastServerToken)}},
            ]}, function(err, cursor) {
            if (err) { fail(res, 2394622, "polis_err_get_pca_results_find", 500); return; }
            cursor.toArray( function(err, docs) {
                if (err) { fail(res, 2389364, "polis_err_get_pca_results_toarray", 500); return; }
                if (docs.length) {
                    res.json(docs[0]);
                } else {
                    // Could actually be a 404, would require more work to determine that.
                    res.status(304).end()
                }
            });
        });

                /*
        redisCloud.get("pca:timestamp:" + stimulus, function(errGetToken, replies) {
            if (errGetToken) {
                fail(res, 287472365, errGetToken, 404);
                return;
            }
            var timestampOfLatestMath = replies;
            if (timestampOfLatestMath <= lastServerToken) {
                res.end(204); // No Content
                // log?
                return;
            }
            // OK, looks like some newer math results are available, let's fetch those.
            redisCloud.get("pca:" + stimulus, function(errGetToken, replies) {
                if (errGetToken) {
                    fail(res, 287472364, errGetToken);
                    return;
                }
                res.json({
                    lastServerToken: lastServerToken,
                    pca: replies,
                });
            });
        });
        */
    });

app.post("/v3/auth/deregister",
express.bodyParser(),
auth,
function(req, res) {
    var data = req.body;
    endSession(data, function(err, data) {
        if (err) { fail(res, 213489289, "couldn't end session"); return; }
        res.end();
    });
});

app.post("/v3/participants",
express.bodyParser(),
auth,
function(req, res) {
    var data = req.body;

    var cid = data.cid;
    var uid = data.uid;
    client.query("INSERT INTO participants (pid, cid, uid, created) VALUES (0, $1, $2, default) RETURNING pid;", [cid, uid], function(err, docs) {
        if (err) { fail(res, 213489292, "polis_err_add_participant"); return; }
        var pid = docs && docs[0] && docs[0].pid;
        res.json({
            pid: pid,
        });
    });
});

// client should really supply this
//function getParticipantId(uid, cid, callback) {
    //client.query("SELECT pid FROM participants WHERE uid = ($1) && cid = ($2);", [uid, cid], function(err, docs) {
        //if (err) { callback(err); return; }
        //var pid = docs && docs[0] && docs[0].pid;
        //callback(null, pid);
    //});
//}

app.post("/v3/auth/login",
express.bodyParser(),
function(req, res) {
    var data = req.body;
    var username = data.username;
    var password = data.password;
    var email = data.email;
    var handles = [];
    if (username) { handles.push({username: username}); }
    if (email) { handles.push({email: email}); }
    if (!_.isString(password)) { fail(res, 238943622, "polis_err_login_need_password", 403); return; }
    client.query("SELECT * FROM users WHERE username = ($1) || email = ($2)", [username, email], function(err, docs) {
        if (err) { fail(res, 238943624, "polis_err_login_unknown_user_or_password", 403); return; }
        if (!docs || docs.length === 0) { fail(res, 238943625, "polis_err_login_unknown_user_or_password", 403); return; }
        var hashedPassword  = docs[0].pwhash;
        var userID = docs[0].uid;

        bcrypt.compare(password, hashedPassword, function(errCompare, result) {
            if (errCompare || !result) { fail(res, 238943623, "polis_err_login_unknown_user_or_password", 403); return; }
            
            startSession(userID, function(errSess, token) {
                var response_data = {
                    username: username,
                    email: email,
                    token: token
                };
                res.json(response_data);
            }); // startSession
        }); // compare
    }); // query
}); // /v3/auth/login

app.post("/v3/auth/new",
express.bodyParser(),
function(req, res) {
    var data = req.body;
    var username = data.username;
    var password = data.password;
    var email = data.email;
    if (ALLOW_ANON && data.anon) {
        var query = client.query("INSERT INTO users (uid, created) VALUES (default, default) RETURNING uid;", [], function(err, result) {
            if (err) {
                console.error(57493883);
                console.dir(err);
                res.status(500).end()
                return;
            }

            var uid = result && result[0] && result[0].uid;
            startSession(uid, function(errSessionStart,token) {
                if (errSessionStart) { fail(res, 238943597, "polis_err_reg_failed_to_start_session_anon"); return; }
                var response = result.rows && result.rows[0]
                res.status(200).json({
                    u: uid,
                    token: token
                });
            });
        });
        return;
    }
    // not anon
    if (!email && !username) { fail(res, 5748932, "polis_err_reg_need_username_or_email"); return; }
    if (!password) { fail(res, 5748933, "polis_err_reg_password"); return; }
    if (password.length < 6) { fail(res, 5748933, "polis_err_reg_password_too_short"); return; }
    if (!_.contains(email, "@") || email.length < 3) { fail(res, 5748934, "polis_err_reg_bad_email"); return; }

    var query = client.query("SELECT * FROM users WHERE username = ($1) || email = ($2)", [username, email], function(err, docs) {
        if (err) { fail(res, 5748936, "polis_err_reg_checking_existing_users"); return; }
            if (err) { console.error(err); fail(res, 5748935, "polis_err_reg_checking_existing_users"); return; }
            if (docs.length > 0) { fail(res, 5748934, "polis_err_reg_user_exists", 403); return; }

            bcrypt.genSalt(12, function(errSalt, salt) {
                if (errSalt) { fail(res, 238943585, "polis_err_reg_123"); return; }

                bcrypt.hash(password, salt, function(errHash, hashedPassword) {
                    delete data.password;
                    password = null;
                    if (errHash) { fail(res, 238943594, "polis_err_reg_124"); return; }
                    client.query("INSERT INTO users (uid, username, email, pwhash, created) VALUES (default, $1, $2, $3, default) RETURNING uid;", [username, email, hashedPassword], function(err, result) {
                        if (err) { fail(res, 238943599, "polis_err_reg_failed_to_add_user_record"); return; }
                        var uid = result && result[0] && result[0].uid;
                        startSession(uid, function(errSessionStart,token) {
                            if (errSessionStart) { fail(res, 238943600, "polis_err_reg_failed_to_start_session"); return; }
                            res.json({
                                uid: uid,
                                username: username,
                                email: email,
                                token: token
                            });
                        }); // end startSession
                    }); // end insert user
                }); // end hash
            }); // end gensalt
    }); // end find existing users
}); // end /v3/auth/new


app.post("/v2/feedback",
    express.bodyParser(),
    auth,
    function(req, res) {
                var data = req.body;
                    data.events.forEach(function(ev){
                        if (!ev.feedback) { fail(res, 'expected feedback field'); return; }
                        if (data.u) ev.u = ObjectId(data.u); 
                        checkFields(ev);
                        collection.insert(ev, function(err, cursor) {
                            if (err) { fail(res, 324234331, err); return; }
                            res.end();
                        }); // insert
                    }); // each 
    });

app.get("/v3/opinions",
moveToBody,
function(req, res) {
    var cid = req.body.cid;
    var ids = req.body.ids;
    var lastServerToken = req.body.lastServerToken;

    function handleResult(err, docs) {
        if (err) { fail(res, 234234332, err); return; }
            if (docs.length) {
                res.json({
                    lastServerToken: lastServerToken,
                    events: docs,
                });
            } else {
                res.writeHead(304, {
                })
                res.end();
            }
        }
    }
    ids = ids.split(',');
    if (!!ids) {
        client.query("SELECT * FROM opinions WHERE cid = ($1) && created > ($2);", [cid, lastServerToken], handleResult);
    } else {
        var i = 1;
        var ORs = "( " + ids.map(function(id) { return "oid = ($" + (i++) + ")"; }) + " )";
        ids.push(cid);
        client.query("SELECT * FROM opinions WHERE "+ ORs +" && cid = ($"+ (i++) + ");", ids], handleResult);
    }
});

app.post("/v3/opinions",
express.bodyParser(),
auth,
function(req, res) {
    var data = req.body;
    data.events.forEach(function(ev){
        if (!ev.txt) { fail(res, 'expected txt field'); return; }
        var cid = data.cid;
        var pid = data.pid;
        var txt = data.txt;
        client.query("INSERT INTO opinions (oid, pid, cid, txt, created) VALUES (0, $1, $2, $3, default);", [pid, cid, txt], function(err, docs) {
            if (err) { fail(res, 324234331, err); return; }
            var oid = result && result[0] && result[0].oid;
            // Since the user posted it, we'll submit an auto-pull for that.
            var autoPull = {
                cid: cid,
                type: polisTypes.reactions.pull,
                oid: oid,
                pid: pid
            };
            reactionsPost(res, pid, cid, [autoPull]);
        }); // insert
    }); // each 
}); // end POST /v3/opinions

app.get("/v3/reactions/me",
moveToBody,
auth,
function(req, res) {
    var data = req.body;
    client.query("SELECT * FROM votes WHERE cid = ($1) && pid = ($2);", [data.cid, data.pid], function(err, docs) {
        if (err) { fail(res, 234234325, err); return; }
        res.json({
            events: docs
        });
    });
});


// TODO Since we know what is selected, we also know what is not selected. So server can compute the ratio of support for a comment inside and outside the selection, and if the ratio is higher inside, rank those higher.
app.get("/v2/selection",
    moveToBody,
    function(req, res) {
        var stimulus = req.body.s;
        if (!req.body.users) {
            res.json([]);
            return;
        }
        function makeGetReactionsByUserQuery(users, stimulus) {
            users = users.split(',');
            var q = { $and: [
                match("s", stimulus),
                {$or: [{type: polisTypes.reactions.pull}, {type: polisTypes.reactions.push}]},
                {$or: users.map(function(id) { return { u: ObjectId(id)}; })},
                {to: {$exists: true}}
                ]
            };
            return q;
        }
        var q = makeGetReactionsByUserQuery(req.body.users, stimulus);
        collection.find(q, function(err, cursor) {
            if (err) { fail(res, 2389369, "polis_err_get_selection", 500); return; }
            cursor.toArray( function(err, reactions) {
                if (err) { fail(res, 2389365, "polis_err_get_selection_toarray", 500); return; }
                var commentIdCounts = {};
                for (var i = 0; i < reactions.length; i++) {
                    if (reactions[i].to) { // TODO why might .to be undefined?
                        var count = commentIdCounts[reactions[i].to];
                        if (reactions[i].type === polisTypes.reactions.pull) {
                            commentIdCounts[reactions[i].to] = count + 1 || 1;
                        } else if (reactions[i].type === polisTypes.reactions.push) {
                            // push
                            commentIdCounts[reactions[i].to] = count - 1 || -1;
                        } else {
                            console.error("expected just push and pull in query");
                        }
                    }
                }
                commentIdCounts = _.pairs(commentIdCounts);
                commentIdCounts = commentIdCounts.filter(function(c) { return Number(c[1]) > 0; }); // remove net negative items
                commentIdCounts.forEach(function(c) { c[0].txt += c[1]; }); // remove net negative items
                commentIdCounts.sort(function(a,b) {
                    return b[1] - a[1]; // descending by freq
                });
                commentIdCounts = commentIdCounts.slice(0, 10);
                var commentIds = commentIdCounts.map(function(x) { return {_id: ObjectId(x[0])};});
                var qq = { $and: [
                    match("s", stimulus),
                    {txt: {$exists: true}},
                    {$or : commentIds}
                    ]
                };
                collection.find(qq, function(err, commentsCursor) {
                    if (err) { fail(res, 2389366, "polis_err_get_selection_comments", 500); return; }
                    commentsCursor.toArray( function(err, comments) {
                        if (err) { fail(res, 2389367, "polis_err_get_selection_comments_toarray", 500); return; }

                        // map the results onto the commentIds list, which has the right ordering
                        var comments = orderLike(comments, commentIds, "_id");
                        for (var i = 0; i < comments.length; i++) {
                            comments[i].freq = i;
                        }

                        comments.sort(function(a, b) {
                            // desc sort primarily on frequency, then on recency
                            if (b.freq > a.freq) {
                                return 1;
                            } else if (b.freq < a.freq) {
                                return -1;
                            } else {
                                return b._id > a._id;
                            }
                        });
                        // TODO fix and use the stuff above
                        comments.sort(function(a, b) {
                            // desc sort primarily on frequency, then on recency
                            return b._id > a._id;
                        });
                        res.json(comments);
                    });
                });
            });
        });
    });

app.get("/v3/reactions",
    moveToBody,
    function(req, res) {
        reactionsGet(res, req.body);
    });

app.post("/v3/reactions",
    express.bodyParser(),
    auth,
    function(req, res) {
            var data = req.body;
            reactionsPost(res, data.pid, data.cid, data.events);
    });

app.get('/v3/conversations',
moveToBody,
function(req, res) {
  var uid = req.body.uid || 1000;
  query = client.query('SELECT * FROM conversations WHERE owner = ($1);', [uid]);
  var rows = [];
  query.on('row', function(result) {
      rows.push(result);
  });
  query.on('end', function(row, result) {
      res.status(200).json(rows);
  });
});

app.post('/v3/conversations', moveToBody, function(req, res) {
  var uid = req.body.uid || 1000;
  var title = req.body.title || "";
  var body = req.body.body || "";
  query = client.query('INSERT INTO conversations (cid, owner, created, title, body)  VALUES(default, $1, default, $2, $3) RETURNING cid;', [uid, title, body], function(err, result) {
      if (err) {
        console.error(57493879);
        res.status(500).end()
        return;
      }
      var response = result.rows && result.rows[0]
      res.status(200).json(response);
  });
});

app.get('/v3/users', function(req, res) {
    // creating a user may fail, since we randomly generate the uid, and there may be collisions.
    var query = client.query('SELECT * FROM users');
    var responseText = "";
    query.on('row', function(row, result) {
        responseText += row.user_id + "\n";
    });
    query.on('end', function(row, result) {
        res.status(200).end(responseText);
    });
});




function staticFile(req, res) {
    // try to serve a static file
    var requestPath = req.url;
    var contentPath = './src';

    // polis.io/2fdsi style URLs. The JS will interpret the path as stimulusId=2fdsi
    if (/^\/[0-9]/.exec(requestPath) || requestPath === '/') {
        contentPath += '/desktop/index.html';
    } else if (requestPath.indexOf('/static/') === 0) {
        contentPath += requestPath.slice(7);
    }

    var extname = path.extname(contentPath);
    var contentType = 'text/html';
    switch (extname) {
        case '.js':
            contentType = 'text/javascript';
            break;
        case '.css':
            contentType = 'text/css';
            break;
        case '.png':
            contentType = 'image/png';
            break;
        case '.woff':
            contentType = 'application/x-font-woff';
            break;
    }
     
    console.log("PATH " + contentPath);
    fs.exists(contentPath, function(exists) {
        if (exists) {
            fs.readFile(contentPath, function(error, content) {
                if (error) {
                    res.writeHead(404);
                    res.json({status: 404});
                }
                else {
                    res.writeHead(200, { 'Content-Type': contentType });
                    res.end(content, 'utf-8');
                }
            });
        } else {
            res.writeHead(404);
            res.json({status: 404});
        }
    });
}

app.get('/v3/users/new', function(req, res) {
    // creating a user may fail, since we randomly generate the uid, and there may be collisions.
    client.query('INSERT INTO users VALUES(default) returning uid', function(err, result) {
        if (err) {
            /* Example error
            {   [Error: duplicate key value violates unique constraint "users_user_id_key"]
                severity: 'ERROR',
                code: '23505',
                detail: 'Key (user_id)=(6) already exists.',
                file: 'nbtinsert.c',
                line: '397',
                routine: '_bt_check_unique' }
            */
            // make the client try again to get a user id -- don't let the server spin
            res.setHeader('Retry-After', 0);
            console.warn(57493875);
            res.status(500).end(57493875)
            return;
        }
        if (!result) {
            console.error(827982173);
            res.status(500).end(827982173)
        } else {
            res.send('got: ' + result.user_id);
        }
  //});
  //query.on('end', function(result) {
  });
});



function staticFile(req, res) {
    // try to serve a static file
    var requestPath = req.url;
    var contentPath = './src';

    // polis.io/2fdsi style URLs. The JS will interpret the path as stimulusId=2fdsi
    if (/^\/[0-9]/.exec(requestPath) || requestPath === '/') {
        contentPath += '/desktop/index.html';
    } else if (requestPath.indexOf('/static/') === 0) {
        contentPath += requestPath.slice(7);
    }

    var extname = path.extname(contentPath);
    var contentType = 'text/html';
    switch (extname) {
        case '.js':
            contentType = 'text/javascript';
            break;
        case '.css':
            contentType = 'text/css';
            break;
        case '.png':
            contentType = 'image/png';
            break;
        case '.woff':
            contentType = 'application/x-font-woff';
            break;
    }
     
    console.log("PATH " + contentPath);
    fs.exists(contentPath, function(exists) {
        if (exists) {
            fs.readFile(contentPath, function(error, content) {
                if (error) {
                    res.writeHead(404);
                    res.json({status: 404});
                }
                else {
                    res.writeHead(200, { 'Content-Type': contentType });
                    res.end(content, 'utf-8');
                }
            });
        } else {
            res.writeHead(404);
            res.json({status: 404});
        }
    });
}

//app.use(express.static(__dirname + '/src/desktop/index.html'));
//app.use('/static', express.static(__dirname + '/src'));

//app.get('/', staticFile);
app.get('/', function(req, res) {
    res.writeHead(500);
    res.end();
});
app.get(/^\/[0-9]/, staticFile);
app.get(/^\/mobile\//, staticFile);
app.get(/^\/static\//, staticFile);

app.get("/a", function(req,res) {
    res.send('hello world');
});
app.listen(process.env.PORT);

console.log('started on port ' + process.env.PORT);
} // End of initializePolisAPI

async.parallel([connectToMongo, connectToPostgres], initializePolisAPI);
