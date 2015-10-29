var
	cluster = require('cluster'),
	log = true;

if(cluster.isMaster){
	var
		workers = process.env.WORKERS || require('os').cpus().length,
		timeouts = [];

	if(log)console.log('\nCluster :: start cluster with %s available workers', workers);

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
		cluster.fork();
	});
}

if(cluster.isWorker){
	var
		gameport	= process.env.PORT || 8888,
		UUID		= require("node-uuid"),
		path		= require('path'),

		app			= require("express")(),
		server		= require("http").createServer(app),
		sio			= require("socket.io").listen(server),

		game_server = { inspace:{count:0}, online:{count:0} };

	global.appRoot = path.dirname(require.main.filename); //path.resolve(__dirname);
	global.window = global.document = global;
	game_core = require(global.appRoot + "/game.core.js");
	if(log)console.log("\nWorker :: Running - process: %s, appRoot: %s", process.cwd(), global.appRoot);


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
		var nsp = client.nsp.name.substring(1);

		//create ID for client
		client.id = UUID.v1();
		client.emit(MESSAGE_TYPE.connected_to_server, client.id);
		if(log)console.log("\nsocket.io :: "+nsp+" connected \n\t\t id: "+ client.id +"\n\t");

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
		if(log)console.log("\ngame_server.onJoinGame :: \n\t\t id: "+ client.id +"\n\t\t message: "+ msg);

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
		client.player.setActive(msg);
	};

	game_server.onPlayerInput = function(client, input){
		//console.log("game_server.onPlayerInput :: input:["+ input +"] id:"+ client.id +"");
		client.player.setInput(input.charAt(0), input.charAt(1));
	};

	game_server.onDisconnect = function(client){
		if(log)console.log("\ngame_server.onDisconnect :: \n\t\t id: "+ client.id);

		//leave the current game
		if(has(client,"player") && has(client.player,"game")){
			client.player.game.broadcast(MESSAGE_TYPE.player_removed, client.id);
			client.player.destroy();
			delete client.player;
		}

		client.emit(MESSAGE_TYPE.disconnected_from_server);
	};
}


process.on("uncaughtException", function(e){
	sio.emit(MESSAGE_TYPE.disconnected_from_server);

	console.error("\nNode :: ERROR - "+ (new Date()).toUTCString() +" uncaughtException:", e.message);
	console.error(e.stack);
	process.exit(1);
});


if(!Object.keys)Object.keys=function(obj){ var keys=[],k;for(k in obj){if(Object.prototype.hasOwnProperty.call(obj,k))keys.push(k);}return keys; };//Support for older browsers