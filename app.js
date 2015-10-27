var
	gameport	= process.env.PORT || 8888,

	express		= require("express"),
	app			= express(),

	http		= require("http"),
	server		= http.createServer(app),

	io			= require("socket.io"),
	sio			= io.listen(server),

	path		= require('path'),
	UUID		= require("node-uuid"),

	log			= true,
	game_server = { inspace:{count:0}, online:{count:0} };


global.appRoot = path.dirname(require.main.filename); //path.resolve(__dirname);
global.window = global.document = global;
game_core = require(global.appRoot + "/game.core.js");
console.log("Node :: Running - "+ process.cwd());


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

sio.of("/online").on("connection",function(client){
	//create ID for client
	client.id = UUID.v1();
	client.emit(MESSAGE_TYPE.connected_to_server, client.id);
	console.log("\nsocket.io :: online connected \n\t\t id: "+ client.id);

	client.on(MESSAGE_TYPE.join_game, function(msg){ game_server.onJoinGame(client, "online", msg); });
	client.on(MESSAGE_TYPE.player_active, function(msg){ game_server.onPlayerActive(client, msg); });
	client.on(MESSAGE_TYPE.player_input, function(msg){ game_server.onPlayerInput(client, msg); });
	client.on("disconnect", function(){ game_server.onDisconnect(client); });
});

sio.of("/inspace").on("connection",function(client){
	//create ID for client
	client.id = UUID.v1();
	client.emit(MESSAGE_TYPE.connected_to_server, client.id);
	console.log("\nsocket.io :: inspace connected \n\t\t id: "+ client.id);

	client.on(MESSAGE_TYPE.join_game, function(msg){ game_server.onJoinGame(client, "inspace", msg); });
	client.on(MESSAGE_TYPE.player_active, function(msg){ game_server.onPlayerActive(client, msg); });
	client.on(MESSAGE_TYPE.player_input, function(msg){ game_server.onPlayerInput(client, msg); });
	client.on(MESSAGE_TYPE.debug, function(s){
		console.log("\nDEBUG :: "+s);
		var m;
		try{ m=eval(s); } catch(e){ m=e; }
		if(typeof(m)==="object") m=Object.keys(m);
		console.log("\t"+m);
		client.emit(MESSAGE_TYPE.debug, s+"\n"+m);
	});
	client.on("disconnect", function(){
		game_server.onDisconnect(client);
	});
});


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
	console.log("\ngame_server.onJoinGame :: \n\t\t id: "+ client.id +"\n\t\t message: "+ msg);

	//Find first available open game
	var game, foundGame=false, gameList=game_server[gameType];
	if(gameList.count > 0){//try to join current game
		for(var id in gameList){
			if(has(gameList,id) && id!="count" && gameList[id].playersCount<gameList[id].playersMax){
				game = gameList[id];
				foundGame = true;
				break;
			}
		}
	}
	if(!foundGame){
		game=game_server.createGame(gameType);//Create new game
	}

	//Create new player
	client.player = new game_player(client.id, game_player.parseString(msg));
	client.player.client = client;
	game.addPlayer(client.player);

	client.emit(MESSAGE_TYPE.join_game, game.getString());//Notify client
	client.broadcast.emit(MESSAGE_TYPE.player_added, client.player.getString());//Notify other clients
};
game_server.createGame = function(gameType){
	var game = new game_core(UUID.v1(), gameType, true);
	game_server[gameType][game.id] = game;
	game_server[gameType].count++;
	return game;
};

game_server.onPlayerActive = function(client, msg){
	client.player.setActive(msg);
	if(has(client.player,"game")){
		client.broadcast.emit(MESSAGE_TYPE.player_active, (msg*1)+client.player.id);//Notify other clients
	}
};

game_server.onPlayerInput = function(client, input){
	//console.log("game_server.onPlayerInput :: input:["+ input +"] id:"+ client.id +"");
	client.player.setInput(input.charAt(0), input.charAt(1));

	//the player should be in a game, so we can tell that game to handle the input
	/*if(player && player.game && player.game.gamecore){
		player.game.gamecore.handle_server_input(player, input_commands, input_time, input_seq);
	}*/
};

game_server.onDisconnect = function(client){
	console.log("\ngame_server.onDisconnect :: \n\t\t id: "+ client.id);
	client.broadcast.emit(MESSAGE_TYPE.player_removed, client.player.getString());//Notify other clients);

	//leave the current game
	if(has(client,"player") && client.player.getGame()){
		client.player.destroy();
		delete client.player;
	}

	client.emit(MESSAGE_TYPE.disconnected_from_server);
};


if(!Object.keys)Object.keys=function(obj){ var keys=[],k;for(k in obj){if(Object.prototype.hasOwnProperty.call(obj,k))keys.push(k);}return keys; };//Support for older browsers