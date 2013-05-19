/**
 * Copyright (c) 2013 by Thomas "TAT" Andresen
 * 
 * Permission to use and/or distribute this software for any purpose without fee is hereby granted,
 * provided that the above copyright notice and this permission notice appear in all copies.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHORS DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE
 * INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHORS
 * BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER
 * RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
 * OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
 * 
 * @author  Thomas "TAT" Andresen
 */

 var Encoder      = require('node-html-encoder').Encoder,
     EventEmitter = require('events').EventEmitter,
     util         = require('util'),
     http         = require('http'),
     SockJS       = require('sockjs-client'),
     encoder      = new Encoder('entity'),
     apiId        = 0,
     client       = null;

http.OutgoingMessage.prototype.__renderHeaders = http.OutgoingMessage.prototype._renderHeaders;

var PlugDJNode = function(data) {
    this.DISCONNECTED  = 0;
    this.CONNECTING    = 1;
    this.CONNECTED     = 2;

    this.rpcHandlers   = {};
    this.latestRoom    = '';
    this.connectedTime = null;
    this.state         = 0;
    var self           = this,
        Models;

    this.connect = function(room) {
        var _this    = this;
        this.state = this.CONNECTING;
        if (!data.key)
            throw new Error("You must pass the authentication cookie into the plugdj-node object to connect correctly");
        http.OutgoingMessage.prototype._renderHeaders = function() {
            if (this._header)
                throw new Error('Can\'t render headers after they are sent to the client.');
            this.setHeader('Cookie', 'usr="' + data.key + '\"');
            return this.__renderHeaders();
        };
        client = SockJS.create('https://sjs.plug.dj:443/plug');
        client.send = function(data) {
            return this.write(JSON.stringify(data));
        };
        client.on('error', function(e) {
            return _this.emit('error', e);
        });
        client.on('data',this.dataHandler);
        client.on('close', function() {
            _this.state = _this.DISCONNECTED;
            return _this.emit('close');
        });
        return client.on('connection', function() {
            if (data.room || room)
                _this.joinRoom(room ? room : data.room);
            self.connectedTime = new Date();
            _this.state = _this.CONNECTED;
            _this.emit('connected');
            return _this.emit('tcpConnect', client);
        });
    };

    this.dataHandler = function(data) {
        var reply,
            _i,
            _len,
            _this    = this;
        if (typeof(data) === 'string')
            data = JSON.parse(data);
        if (data.messages) {
            for (_i = 0, _len = data.messages.length; _i < _len; _i++)
                self.messageHandler(data.messages[_i]);
            return;
        }
        if (data.type === 'rpc') {
            reply = data.result;
            if (reply && reply.stacktrace) console.log(reply.stacktrace);
            if (data.status !== 0) reply = data;
            if (self.rpcHandlers[data.id] !== null) {
                if (typeof self.rpcHandlers[data.id].callback === "function")
                    self.rpcHandlers[data.id].callback(reply);
            }
            self.parseRPCReply((self.rpcHandlers[data.id] !== null ? self.rpcHandlers[data.id].type : ''), reply);
            return delete self.rpcHandlers[data.id];
        }
    };

    this.parseRPCReply = function(name, data) {
        switch (name) {
            case 'room.join':
                Models.room.setData(data.room);
                Models.user.data = data.user.profile;
                this.roomId      = data.room.id;
                this.historyID   = data.room.historyID;
                this.emit('roomChanged', data);
                this.emit('djAdvance', { historyID: data.room.historyID, media: data.room.media });
                return;
        }
    };

    this.messageHandler = function(msg) {
        switch (msg.type) {
            case 'ping':
                this.sendRPC('user.pong');
                break;
            case 'chat':
                msg.data.message = encoder.htmlDecode(msg.data.message);
                if (Models.user.data.username !== '' && msg.data.message.indexOf('@' + Models.user.data.username) > -1 && msg.data.type != 'emote')
                    msg.data.type = 'mention';
                break;
            case 'djAdvance':
                return this.emit(msg.type, Models.room.djAdvance(msg.data));
                break;
            case 'voteUpdate':
                Models.room.voteUpdate(msg.data);
                break;
            case 'voteUpdateMulti':
                for (var a in msg.data.votes)
                    Models.room.voteUpdate({id:a,vote:msg.data.votes[b]});
                break;
            case 'curateUpdate':
                Models.room.curateUpdate(msg.data);
                break;
            case 'userJoin':
                Models.room.userJoin(msg.data);
                break;
            case 'userLeave':
                Models.room.userLeave(msg.data.id);
                break;
            case 'userUpdate':
                Models.room.userUpdate(msg.data);
                break;
            case void 0:
                console.log('UNKNOWN MESSAGE FORMAT', msg);
        }
        if (msg.type)
            return this.emit(msg.type, msg.data);
    };

    this.sendRPC = function(name, args, callback) {
        if (args === void 0)
            args = [];
        if (Object.prototype.toString.apply(args) !== "[object Array]")
            args = [args];
        var rpcId = ++apiId, sendArgs;
        this.rpcHandlers[rpcId] = {
            callback: callback,
            type: name
        };
        sendArgs = {
            type: 'rpc',
            id: rpcId,
            name: name,
            args: args
        };
        return client.send(sendArgs);
    };

    this.changeRoomInfo = function(name, description, callback) {
        var roomInfo = {
            name: name,
            description: description
        };
        return this.sendRPC("moderate.update", roomInfo, callback);
    };

    this.changeRoomOptions = function(boothLocked, waitListEnabled, maxPlays, maxDJs, callback) {
        var options;
        if (!this.roomId)
            throw new Error('You must be in a room to change its options');
        options = {
            boothLocked: boothLocked,
            waitListEnabled: waitListEnabled,
            maxPlays: maxPlays,
            maxDJs: maxDJs
        };
        return this.sendRPC("room.update_options", [this.roomId, options], callback);
    };

    //FakeModels
    this.Models = {
        user: {
            FEATURED_DJ :  1,
            BOUNCER     :  2,
            MANAGER     :  3,
            COHOST      :  4,
            HOST        :  5,
            AMBASSADOR  :  9,
            ADMIN       : 10,
            data: {},
            getPermission: function(userid) {
                if (!userid) userid = this.data.id;
                var a = 0;
                if (Models.room.admins[userid]) a = 10;
                else if (Models.room.ambassadors[userid]) a = 9;
                else for (var b in Models.room.data.staff) {
                    if (userid == b) {
                        a = Models.room.data.staff[b];
                        break;
                    }
                }
                return a;
            },
            hasPermission: function(required,userid) {
                if (!userid) userid = this.data.id;
                return this.getPermission(userid) >= required;
            }
        },
        room: {
            __events: {},
            earnedPoints: {},
            clear: function() {
                this.data         = {};
                this.djHash       = {};
                this.userHash     = {};
                this.admins       = {};
                this.ambassadors  = {};
                this.earnedPoints = {};
                this.joined = this.userIsPlaying = this.userInBooth = false;
                this.joinTime     = null;
                this.roomScore    = {
                    positive: 0,
                    negative: 0,
                    curates: 0,
                    score: 0.5
                };
            },
            setData: function(a) {
                this.clear();
                this.joined = true;
                this.joinTime = Date.now();
                this.data = a;
                var b = false;
                if (this.data !== undefined) {
                    for (var a = this.data.users.length; a--;) {
                        this.data.users[a].owner = this.data.users[a].id == this.data.owner;
                        this.data.users[a].permission = this.data.staff[this.data.users[a].id] ? this.data.staff[this.data.users[a].id] : 0;
                        this.userHash[this.data.users[a].id] = this.data.users[a];
                        if (this.data.users[a].id == Models.user.data.id)
                            b = true;
                    }
                }
                if (!b) {
                    Models.user.data.owner = Models.user.data.id == this.data.owner;
                    Models.user.data.permission = this.data.staff[Models.user.data.id] ? this.data.staff[Models.user.data.id] : 0;
                    this.data.users.push(Models.user.data);
                    this.userHash[Models.user.data.id] = Models.user.data;
                }
                this.updateEarnedPoints();
            },
            voteUpdate: function(value) {
                if (this.userHash[value.id]) {
                    this.userHash[value.id].vote = value.vote;
                    this.data.votes[value.id] = value.vote;
                    this.earnedPoints[value.id] = 1;
                    if (value.vote == 1 && this.earnedPoints[this.data.currentDJ].v[value.id] != 1) {
                        ++this.earnedPoints[this.data.currentDJ].dj;
                        this.earnedPoints[this.data.currentDJ].v[value.id] = 1;
                    } else if (value.vote == -1 && this.earnedPoints[this.data.currentDJ].v[value.id] == 1) {
                        --this.earnedPoints[this.data.currentDJ].dj;
                        this.earnedPoints[this.data.currentDJ].v[value.id] = -1;
                    }
                    this.updateRoomScore();
                } else console.error("VoteUpdateError :: user " + value.id + " does not exist in room");
            },
            curateUpdate: function(value) {
                if (this.userHash[value.id]) {
                    if (value.curated === undefined)
                        value.curated = true;
                    this.userHash[value.id].curated = value.curated;
                    this.data.curates[value.id] = value.curated;
                    if (this.earnedPoints[this.data.currentDJ]) ++this.earnedPoints[this.data.currentDJ].c;
                    this.updateRoomScore();
                } else console.log("CurateUpdateError :: user", value.id, "does not exist in room");
            },
            sortAudienceAlpha: function(a,b) { return a.username.toLowerCase() > b.username.toLowerCase() ? 1 : a.username.toLowerCase() < b.username.toLowerCase() ? -1 : 0; },
            sortAudienceRelationship: function(a,b) {
                if (a.relationship > b.relationship) return 1;
                if (a.relationship < b.relationship) return -1;
                var c = a.listenerPoints + a.djPoints + a.curatorPoints,
                    d = b.listenerPoints + b.djPoints + b.curatorPoints;
                return c > d ? 1 : c < d ? -1 : 0;
            },
            sortStaff: function(a,b) { return a.permission < b.permission ? 1 : a.permission > b.permission ? -1 : a.username.toLowerCase() > b.username.toLowerCase() ? 1 : a.username.toLowerCase() < b.username.toLowerCase() ? -1 : 0; },
            getUsers: function() {
                var a = this.getDJs().concat(this.getAudience(true));
                a.sort(this.sortAudienceAlpha);
                return a;
            },
            getDJs: function() {
                var a = [];
                if (this.data.djs) {
                    var b = this.data.djs.length;
                    for (var c = 0;c < b;++c) {
                        if (this.userHash[this.data.djs[c].id]) a.push(this.userHash[this.data.djs[c].id]);
                        else console.error("getDJs Error :: " + this.data.djs[c].id + " does not exist in room users");
                    }
                }
                return a;
            },
            getAudience: function (a) {
                var b = [],
                    c = null,
                    d = [];
                for (var e in this.userHash) {
                    if (this.userHash[e].id == Models.user.data.id) c = this.userHash[e]
                    else if (!this.djHash[this.userHash[e].id]) {
                        if (this.admins[e] || this.ambassadors[e] || this.data.staff[e]) d.push(this.userHash[e])
                        else b.push(this.userHash[e]);
                    }
                }
                if (a) b.sort(this.sortAudienceAlpha);
                else b.sort(this.sortAudienceRelationship);
                b = d.concat(b);
                if (c && !this.djHash[c.id]) b.unshift(c);
                return b;
            },
            getUserByID: function(a) {
                return this.userHash[a];
            },
            getWaitList: function() {
                var result = [];
                if (this.data.waitList) {
                    var len = this.data.waitList.length;
                    for (var a = 0;a < len;++a) {
                        if (!this.userHash[this.data.waitList[a].id])
                            this.userJoin(this.data.waitList[a])
                        result.push(this.userHash[this.data.waitList[a].id]);
                    }
                }
                return result;
            },
            getStaff: function() {
                var a = [];
                for (var b in this.data.staff) {
                    if (this.userHash[b])
                        a.push(this.userHash[b]);
                }
                a.sort(this.sortStaff);
                return a;
            },
            getAmbassadors: function() {
                var a = [],
                    b = this.data.ambassadors.length;
                for (var c = 0;c < b;++c) {
                    this.userHash[this.data.ambassadors[c]];
                    a.push(this.userHash[this.data.ambassadors[c]]);
                }
                return a;
            },
            getSuperUsers: function() {
                var a = [],
                    b = this.data.admins.length;
                for (var c = 0;c < b;++c) {
                    this.userHash[this.data.admins[c]];
                    a.push(this.userHash[this.data.admins[c]]);
                }
                return a;
            },
            getHost: function() {
                return this.userHash[this.data.owner] ? this.userHash[this.data.owner] : null;
            },
            updateRoomScore: function() {
                if (this.data.media) {
                    var a, b = 0, c = 0, d = 0;
                    for (a in this.data.votes) 1 == this.data.votes[a] ? ++b : -1 == this.data.votes[a] && ++c;
                    for (a in this.data.curates) ++d;
                    a = this.data.users.length - 1;
                    var e = 0;
                    0 < a && (e = (b - c) / (2 * a));
                    this.roomScore = {
                        positive: b,
                        negative: c,
                        curates: d,
                        score: 0.5 + e
                    };
                    this.dispatchEvent("scoreUpdate", this.roomScore);
                } else this.roomScore = {
                    positive: 0,
                    negative: 0,
                    curates: 0,
                    score: 0.5
                }, this.dispatchEvent("scoreUpdate", this.roomScore);
            },
            djAdvance: function(value) {
                var lastPlay;
                if (this.data.media) {
                    lastPlay = {
                        dj: this.userHash[this.data.currentDJ],
                        media: Utils.clone(this.data.media),
                        score: Utils.clone(this.roomScore)
                    };
                    this.applyEarnedPoints(value.earn);
                }
                this.data.votes = {};
                this.data.curates = {};
                try {
                    var i = this.data.users.length;
                    while (i--) {
                        if (this.data.users[i]) {
                            this.data.users[i].vote = 0;
                            this.data.users[i].curated = false;
                        }
                    }
                } catch (e) {
                    console.error("ClearVotes", e);
                }
                this.data.media = value.media;
                this.data.currentDJ = value.currentDJ;
                this.data.playlistID = value.playlistID;
                this.data.historyID = value.historyID;
                this.roomScore = {
                    positive: 0,
                    negative: 0,
                    curates: 0,
                    score: 0.5
                };
                this.updateEarnedPoints();
                if (this.data.media && this.data.currentDJ)
                    return {
                        dj: this.userHash[this.data.currentDJ],
                        media: this.data.media,
                        lastPlay: lastPlay
                    };
                else 
                    return {
                        lastPlay: lastPlay
                    };
            },
            updateEarnedPoints: function() {
                var a;
                try {
                    this.earnedPoints = {};
                    for (a in this.userHash) this.earnedPoints[a] = 0;
                    if (this.data.currentDJ) {
                        this.earnedPoints[this.data.currentDJ] = {
                            dj: 0,
                            c: 0,
                            v: {}
                        };
                        for (a in this.data.curated)
                            this.earnedPoints[this.data.currentDJ].c += 1;
                        for (a in this.userHash) {
                            if (this.userHash[a].vote == -1)
                                this.earnedPoints[a] = 1
                            else if (this.userHash[a].vote == 1) {
                                this.earnedPoints[a] = 1;
                                this.earnedPoints[this.data.currentDJ].dj += 1;
                                this.earnedPoints[this.data.currentDJ].v[a] = 1;
                            } else if (this.userHash[a].vote == -1)
                                this.earnedPoints[this.data.currentDJ].v[a] = -1;
                            else if (a != this.data.currentDJ)
                                this.earnedPoints[a] = 0;
                        }
                    }
                } catch (b) {
                    for (a in this.userHash) this.earnedPoints[a] = 0;
                    console.log('Error in updateEarnedPoints',b);
                }
            },
            applyEarnedPoints: function (value) {
                try {
                    if (value) {
                        for (var a in this.earnedPoints) {
                            if (this.userHash[a]) {
                                if (a == this.data.currentDJ) {
                                    this.userHash[this.data.currentDJ].djPoints += this.earnedPoints[this.data.currentDJ].dj || 0;
                                    this.userHash[this.data.currentDJ].curatorPoints += this.earnedPoints[this.data.currentDJ].c || 0;
                                } else if (this.earnedPoints[a] == 1)++this.userHash[a].listenerPoints;
                                if (a == Models.user.data.id) {
                                    Models.user.data.djPoints = this.userHash[a].djPoints;
                                    Models.user.data.listenerPoints = this.userHash[a].listenerPoints;
                                    Models.user.data.curatorPoints = this.userHash[a].curatorPoints;
                                }
                            }
                        }
                    } else {
                        if (this.userHash[this.data.currentDJ]) this.userHash[this.data.currentDJ].curatorPoints += this.earnedPoints[this.data.currentDJ].c || 0;
                        if (Models.user.data.id == this.data.currentDJ) Models.user.data.curatorPoints = this.userHash[Models.user.data.id].curatorPoints;
                    }
                } catch (e) {
                    console.log("applyEarnedPoints error");
                    console.log(e);
                }
            },
            userJoin: function(a) {
                if (!this.userHash[a.id]) {
                    this.data.users.push(a);
                    this.userHash[a.id] = a;
                }
                this.updateRoomScore();
            },
            userLeave: function(a) {
                if (this.userHash[a]) {
                    delete this.userHash[a];
                    if (this.data.votes[a] === 1 && this.earnedPoints[this.data.currentDJ])
                        --this.earnedPoints[this.data.currentDJ].dj;
                    delete this.data.votes[a];
                    try {
                        for (var b = this.data.users.length; b--;) if (this.data.users[b].id == a) {
                            this.data.users.splice(b, 1);
                            break
                        }
                    } catch (c) {
                        console.error(c)
                    }
                    this.updateRoomScore();
                }
            },
            userUpdate: function(a) {
                if (this.data.users) {
                    var b = this.userHash[a.id];
                    if (b) {
                        b.fans = a.fans;
                        b.facebook = a.facebook;
                        b.twitter = a.twitter;
                        b.djPoints = a.djPoints;
                        b.listenerPoints = a.listenerPoints;
                        b.curatorPoints = a.curatorPoints;
                        b.username = a.username;
                        b.status = a.status;
                        b.id == this.data.currentDJ && this.dispatchEvent("mediaUpdate", {
                            djName: b.username,
                            media: this.data.media
                        });
                        b.avatarID = a.avatarID;
                        if (b.id === Models.user.data.id)
                            Models.user.data = b;
                    }
                }
            },
            addEventListener: function(a,b) {
                this.__events[a] = this.__events[a] || [];
                this.__events[a].unshift(b);
            },
            removeEventListener: function(a,b) {
                if (this.__events[a]) {
                    var c = this.__events[a];
                    for (var d = 0;d < c.length;d++)
                        if (c[d] === b)
                            return c.splice(d,1),!0;
                }
            },
            dispatchEvent: function(a,b) {
                if (this.__events[a]) {
                    var c = this.__events[a];
                    for (var d = 0;d < c.length;d++)
                        c[d](b);
                }
            }
        }
    };
    Models = this.Models;
    Models.room.clear();

    Utils = {
        clone: function (a){ var b={},c; for(c in a) b[c] = a[c]; return b; }
    }

    this.joinRoom       = function(name, callback)     { this.latestRoom = name; return this.sendRPC('room.join', [name], callback); };
    this.chat           = function(msg)                { return client.send({ type: 'chat', msg: msg }); };
    this.woot           = function(callback)           { this.sendRPC("room.cast", [true,  this.historyID, this.lastHistoryID === this.historyID], callback); return this.lastHistoryID = this.historyID; };
    this.meh            = function(callback)           { this.sendRPC("room.cast", [false, this.historyID, this.lastHistoryID === this.historyID], callback); return this.lastHistoryID = this.historyID; };
    this.vote           = function(vote, callback)     { if (vote !== -1 && vote !== 1) return null; return vote === 1 ? this.woot(callback) : this.meh(callback); };
    this.joinBooth      = function(callback)           { return this.sendRPC("booth.join", [], callback); };
    this.leaveBooth     = function(callback)           { return this.sendRPC("booth.leave", [], callback); };
    this.changeName     = function(name, callback)     { return 2 < name.length && -1 == name.indexOf("http://") ? this.sendRPC("user.change_name", [name], callback) : callback({status:5}); }
    this.addDJ          = function(userid, callback)   { return userid === Models.user.data.id ? this.joinBooth(callback)  : this.sendRPC("moderate.add_dj", userid, callback); };
    this.removeDJ       = function(userid, callback)   { return userid === Models.user.data.id ? this.leaveBooth(callback) : this.sendRPC("moderate.remove_dj", userid, callback); };
    this.skip           = function(callback)           { return this.sendRPC("moderate.skip", this.historyID, callback); };
    this.setPermissions = function(userid, permission) { return this.sendRPC("moderate.permissions", [userid, permission]); };
    this.deleteChat     = function(cid)                { return this.sendRPC("moderate.chat_delete", cid); };
    this.kickUser       = function(userid, reason)     { if (userid === Models.user.data.id) return null; return this.sendRPC("moderate.kick",[userid,reason,60]); };
    this.banUser        = function(userid, reason)     { if (userid === Models.user.data.id) return null; return this.sendRPC("moderate.kick",[userid,reason,-1]); };
};

util.inherits(PlugDJNode,EventEmitter);

var FakeAPI = function(bot) {
    if (!bot instanceof PlugDJNode)
        throw new Error('You tried to make a FakeAPI for other than plugdj-node');

    this.__events            = {};
    _this                    = this;
    Models                   = bot.Models;

    this.CHAT                = "chat";
    this.USER_SKIP           = "userSkip";
    this.USER_JOIN           = "userJoin";
    this.USER_LEAVE          = "userLeave";
    this.USER_FAN            = "userFan";
    this.FRIEND_JOIN         = "friendJoin";
    this.FAN_JOIN            = "fanJoin";
    this.VOTE_UPDATE         = "voteUpdate";
    this.CURATE_UPDATE       = "curateUpdate";
    this.ROOM_SCORE_UPDATE   = "roomScoreUpdate";
    this.DJ_ADVANCE          = "djAdvance";
    this.DJ_UPDATE           = "djUpdate";
    this.VOTE_SKIP           = "voteSkip";
    this.MOD_SKIP            = "modSkip";
    this.WAIT_LIST_UPDATE    = "waitListUpdate";

    this.getUsers            = function()    { return bot.state == bot.CONNECTED ? Models.room.getUsers() : []; };
    this.getUser             = function(a)   { return bot.state == bot.CONNECTED ? Models.room.getUserByID(a) : []; };
    this.getSelf             = function()    { return bot.state == bot.CONNECTED ? Models.room.getUserByID(Models.user.data.id) : {}; };
    this.getAudience         = function()    { return bot.state == bot.CONNECTED ? Models.room.getAudience() : []; };
    this.getDJs              = function()    { return bot.state == bot.CONNECTED ? Models.room.getDJs() : []; };
    this.getStaff            = function()    { return bot.state == bot.CONNECTED ? Models.room.getStaff() : []; };
    this.getAdmins           = function()    { return bot.state == bot.CONNECTED ? Models.room.getSuperUsers() : []; };
    this.getAmbassadors      = function()    { return bot.state == bot.CONNECTED ? Models.room.getAmbassadors() : []; };
    this.getHost             = function()    { return bot.state == bot.CONNECTED ? Models.room.getHost() : []; };
    this.getMedia            = function()    { return bot.state == bot.CONNECTED ? Models.room.data.media : null; };
    this.getWaitList         = function()    { return bot.state == bot.CONNECTED ? Models.room.getWaitList() : []; };
    this.getRoomScore        = function()    { return bot.state == bot.CONNECTED ? Models.room.roomScore : {}; };
    this.sendChat            = function(a)   { if (bot.state == bot.CONNECTED) bot.chat(a); };
    this.waitListJoin        = function()    { if (bot.state == bot.CONNECTED) bot.joinBooth(); };
    this.waitListLeave       = function()    { if (bot.state == bot.CONNECTED) bot.leaveBooth(); };
    this.moderateForceSkip   = function()    { if (bot.state == bot.CONNECTED) bot.skip(); };
    this.moderateAddDJ       = function(a)   { if (bot.state == bot.CONNECTED) bot.addDJ(a); };
    this.moderateRemoveDJ    = function(a)   { if (bot.state == bot.CONNECTED) bot.removeDJ(a); };
    this.moderateKickUser    = function(a,b) { if (bot.state == bot.CONNECTED) bot.kickUser(a,b); };
    this.moderateBanUser     = function(a,b) { if (bot.state == bot.CONNECTED) bot.banUser(a,b); };
    this.moderateDeleteChat  = function(a)   { if (bot.state == bot.CONNECTED) bot.deleteChat(a); };
    this.moderateSetRole     = function(a,b) { if (bot.state == bot.CONNECTED) bot.setPermissions(a,b); };
    this.delayDispatch       = function(a,b) { if (bot.state == bot.CONNECTED && _this.__events[a]) setTimeout(function() { _this.dispatchEvent(a,b); a = b = null; },1E3); };
    this.addEventListener    = function(a,b) { _this.__events[a] = _this.__events[a] || []; _this.__events[a].unshift(b); };
    this.removeEventListener = function(a,b) {
        if (_this.__events[a]) {
            var c = _this.__events[a];
            for (var d = 0;d < c.length;d++)
                if (c[d] === b)
                    return c.splice(d,1),!0;
        }
    };
    this.dispatchEvent       = function(a,b) {
        if (_this.__events[a]) {
            var c = _this.__events[a];
            for (var d = 0;d < c.length;d++)
                c[d](b);
        }
    };
};

exports.PlugDJNode = PlugDJNode;
exports.FakeAPI = FakeAPI;