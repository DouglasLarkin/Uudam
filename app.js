var
	cluster = require("cluster"),
	log = true;

/* Master Process */
if(cluster.isMaster){
	var
		workers = process.env.WORKERS || require('os').cpus().length,
		timeouts = [];

	if(log)console.log("\nCluster :: start cluster with %s available workers", workers);

	if(workers>1) workers=1;
	for(var i=workers-1; i>=0; i--){
		var worker = cluster.fork().process;
		if(log)console.log('\tworker %s started.', worker.pid);
	}

	var workerTimeout = function(){
		console.error("\nCluster :: workerTimeout connection failed...");
	};
	cluster.on('fork', function(worker){ timeouts[worker.pid]=setTimeout(workerTimeout,2000); });
	cluster.on('listening', function(worker,address){ clearTimeout(timeouts[worker.pid]); });

	cluster.on('exit', function(worker, code, signal){
		clearTimeout(timeouts[worker.pid]);
		console.warn('\nCluster :: worker %d died (%s). \n\tRestarting...', worker.process.pid, signal || code);

		//restart child process
		cluster.fork();
	});
}


/* Child Proces */
if(cluster.isWorker){
	var
		gameport	= process.env.PORT || 8888,
		UUID		= require("node-uuid"),
		path		= require('path'),

		app			= require("express")(),
		server		= require("http").createServer(app),
		sio			= require("socket.io").listen(server),

		game_server = { inspace:{count:0}, online:{count:0} };
		player_list = {};

	global.appRoot = path.dirname(require.main.filename); //path.resolve(__dirname);
	global.window = global.document = global;
	
	if(log)console.log("\nWorker :: Running - process: %s, appRoot: %s", process.cwd(), global.appRoot);
	global.b2d = require("box2dnode");//Init Physics
	require(global.appRoot + "/game.core.js");

	/*	Express */

	server.listen(gameport);
	console.log("\nExpress :: Listening on port "+ gameport);

	app.get("/",function(req,res){
		if(log)console.log("\nExpress :: Loading %s", __dirname +"/index.html");
		res.sendFile("/index.html", {root:global.appRoot});
	});
	app.get("/inspace",function(req,res){
		if(log)console.log("\nExpress :: Loading %s", __dirname +"/inspace.html");
		res.sendFile("/inspace.html", {root:global.appRoot});
	});
	app.get("/*",function(req,res,next){
		var file = req.params[0];
		if(log)console.log("\nExpress :: File requested : "+ __dirname+"/"+file);
		res.sendFile("/"+ file, {root:global.appRoot});
	});


	/*	Socket.IO */

	socketOnConnection = function(client){
		client.id = UUID.v1();//create ID for client
		var nsp = client.nsp.name.substring(1);

		client.on(MESSAGE_TYPE.join_game, function(msg){ game_server.onJoinGame(client, nsp, msg); });
		client.on(MESSAGE_TYPE.player_active, function(msg){ game_server.onPlayerActive(client, msg); });
		client.on(MESSAGE_TYPE.player_input, function(msg){ game_server.onPlayerInput(client, msg); });
		client.on("disconnect", function(){ game_server.onDisconnect(client); });

		if(nsp=="inspace"){
			client.on(MESSAGE_TYPE.debug, function(s){
				console.log("\nDEBUG :: "+s);
				var m;
				try{ m=eval(s); } catch(e){ m=e; }
				if(typeof(m)==="object") m=Object.keys(m);
				console.log(m);
				client.emit(MESSAGE_TYPE.debug, s+"\n"+m);
			});
		}
		
		if(log)console.log("\nsocket.io :: "+nsp+" connected - id: "+ client.id);
		client.emit(MESSAGE_TYPE.connected_to_server, client.id);
	};

	sio.of("/online").on("connection",socketOnConnection);
	sio.of("/inspace").on("connection",socketOnConnection);


	/* Game Server */

	game_server.local_time = 0;
	game_server._dt = game_server._dte = new Date().getTime();

	setInterval(function(){
		game_server._dt = new Date().getTime() - game_server._dte;
		game_server._dte = new Date().getTime();
		game_server.local_time += game_server._dt / 1000.0;
	}, 4);


	/* Handle server inputs */

	game_server.onJoinGame = function(client, gameType, msg){
		if(log)console.log("\ngame_server.onJoinGame :: id: "+client.id+", gameType: "+gameType);

		//Find first available open game
		var game, foundGame=false, gameList=game_server[gameType];
		if(gameList.count > 0){//try to join current game
			for(var id in gameList){
				if(has(gameList,id) && id!="count" && gameList[id].playersCount < gameList[id].playersMax){
					game = gameList[id];
					foundGame = true;
					break;
				}
			}
		}
		if(!foundGame) game = game_server.createGame(gameType);//Create new game

		//Create new player
		client.player = new game_player(client.id, game_player.parseString(msg));
		client.player.client = client;
		game.addPlayer(client.player);
		player_list[client.player.id] = client.player;

		client.emit(MESSAGE_TYPE.join_game, game.getString());//Notify client
		game.broadcast(MESSAGE_TYPE.player_added, client.player.getString(), client.player.id);
		//client.broadcast.emit(MESSAGE_TYPE.player_added, client.player.getString());//Notify other clients
	};
	game_server.createGame = function(gameType){
		var game = new game_core(UUID.v1(), gameType, true);
		game_server[gameType][game.id] = game;
		game_server[gameType].count++;
		return game;
	};

	game_server.onPlayerActive = function(client, msg){
		var a = msg.substr(0,1)=="1",
			id = msg.substring(1);
		if(has(player_list,id)) player_list[id].setActive(a);
		//client.player.setActive(msg);
	};

	game_server.onPlayerInput = function(client, msg){
		var id = msg.substring(2);
		//console.log("game_server.onPlayerInput :: input:["+ msg.substr(0,2) +"] id:"+ id +"");
		if(has(player_list,id)) player_list[id].setInput(msg.charAt(0), msg.charAt(1));
	};

	game_server.onDisconnect = function(client){
		if(log)console.log("\ngame_server.onDisconnect :: \n\t\t id: "+ client.id);

		//leave the current game
		if(has(client,"player") && has(client.player,"game")){
			if(has(player_list, client.player.id)) delete player_list[client.player.id];
			client.player.game.broadcast(MESSAGE_TYPE.player_removed, client.id);
			client.player.destroy();
			delete client.player;
		}
		client.emit(MESSAGE_TYPE.disconnected_from_server);
	};
}


/* Process Handling */

process.on("uncaughtException", function(e){
	//sio.emit(MESSAGE_TYPE.disconnected_from_server);
	console.error("\nNode :: ERROR - "+ (new Date()).toUTCString() +" uncaughtException:", e.message);
	console.error(e.stack);

	gracefulShutdown(function(){
		process.exit(1);
	});
});

process.on('SIGUSR2', function(){
	console.log("CLOSING [SIGUSR2] NODEMON KILL");	gracefulShutdown(function(){process.kill(process.pid,'SIGUSR2');});
});
process.on('SIGHUP',  function(){console.log('CLOSING [SIGHUP]');  gracefulShutdown()});
process.on('SIGINT',  function(){console.log('CLOSING [SIGINT]');  gracefulShutdown()});
process.on('SIGQUIT', function(){console.log('CLOSING [SIGQUIT]'); gracefulShutdown()});
process.on('SIGABRT', function(){console.log('CLOSING [SIGABRT]'); gracefulShutdown()});
process.on('SIGTERM', function(){console.log('CLOSING [SIGTERM]'); gracefulShutdown()});
process.on('beforeExit', function(){console.log("CLOSING [beforeExit]");});

var gracefulShutdown = function(callback){
	console.log("Node :: Received kill signal, shutting down gracefully.");
	if(typeof callback !== "function") callback = process.exit;
	if(typeof server !== "undefined"){
		if(typeof sio !== "undefined") sio.emit(MESSAGE_TYPE.disconnected_from_server);
		
		server.close(function(){
			console.log("Node :: Closed out remaining connections.");
			callback();
		});
		setTimeout(function(){//if after
			console.error("Node :: Could not close connections in time, forcefully shutting down");
			callback();
		}, 3*1000);
	}else
		callback();
};


if(!Object.keys)Object.keys=function(obj){ var keys=[],k;for(k in obj){if(Object.prototype.hasOwnProperty.call(obj,k))keys.push(k);}return keys; };//Support for older browsers