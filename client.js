var server={};

function init(namespace){
	//Connect to server
	server = new Server(":8888/"+namespace);

	//Lock canvas size
	window.addEventListener("resize", debounce(resizeCanvas), !1);
	resizeCanvas();

	//Init controls
	Controls.init();
}


var Server = function(namespace){
	this.game = {};
	this.player = {};
	this.localCanvas = document.getElementById("viewport");
	this.drawCanvas = document.getElementById("draw");

	this.connection = io.connect(namespace);
	this.createHandlers();
};

Server.prototype.createHandlers = function(){
	var t=this;

	t.connection.on(MESSAGE_TYPE.connected_to_server, function(msg){
		//console.log("\ninspace :: connected_to_server - "+ msg, t);

		t.player = t.initialisePlayer(msg);

		//Send our player to the server
		t.connection.emit(MESSAGE_TYPE.join_game, t.player.getString());
	});
	t.connection.on(MESSAGE_TYPE.disconnected_from_server, function(){
		console.log("\ninspace :: disconnected_from_server");//end game
	});

	t.connection.on(MESSAGE_TYPE.join_game, function(msg){
		console.log("\ninspace :: join_game - %o", game_core.parseString(msg));
		var state=game_core.parseString(msg);
		if(!state){ console.warn("\ninspace :: join_game - ERROR game_core.parseString failed "+msg); return !1; }

		//Init game instancec
		t.initialiseGame(state);

		//Send ready state to server
		t.connection.emit(MESSAGE_TYPE.player_active, "1"+t.player.id);
	});

	t.connection.on(MESSAGE_TYPE.player_added, function(msg){
		var state = game_player.parseString(msg);
		if(!state || !has(state,"id")){ console.warn("\ninspace :: player_added - ERROR game_player.parseString failed "+msg); return !1; }

		if(state.id != t.player.id){
			console.log("\ninspace :: player_added - %s %o", state.id, state);
			t.game.addPlayer(t.initialisePlayer(state.id, state));
		}
	});
	t.connection.on(MESSAGE_TYPE.player_removed, function(msg){
		//var state = game_player.parseString(msg);
		//if(!state || !has(state,"id")){ console.warn("\ninspace :: player_removed - ERROR game_player.parseString failed "+msg); return !1; }

		if(has(t.game.players, msg)){//remove the old inactive player
			t.game.players[msg].destroy();
			console.log("\ninspace :: player_removed "+t.game.players[msg].sid+" msg: "+msg);
		}else{
			console.log("\ninspace :: player_removed - ERROR player not found "+msg);
		}
	});
	t.connection.on(MESSAGE_TYPE.player_active, function(msg){
		var a = msg.substr(0,1)=="1",
			id = msg.substring(1);
		if(has(t.game.players,id)){
			console.log("\ninspace :: player_active "+t.game.players[id].sid+" - active: %s, id: %s", a, id);
			t.game.players[id].setActive(a);
			if(!a && id == t.player.id){
				console.warn("inspace :: player_active "+t.player.sid+" - ERROR Self deactivated!");
				t.clearCanvas();
				//setTimeout(function(){ location.reload(true); }, 1000);
			}
		}else{ console.warn("\ninspace :: player_active - ERROR game_player not found "+msg); return !1; }
	});

	t.connection.on(MESSAGE_TYPE.server_state_update, function(msg){
		//console.log("inspace :: server_state_update - %o",msg);
		t.game.server_updates.push(msg.split("~"));
	});

	t.connection.on(MESSAGE_TYPE.debug, function(msg){ console.log("\ninspace :: debug - "+msg); });

	window.addEventListener("Controls.onChange", function(e){//Update inputs
		var k = e.detail.key,
			key = Controls.KEYS[k];
		//console.log("inspace :: Controls.onChange - %s %o", k, key);
		t.player.setInput(key.dir, Controls.isPressed(k));

		//Send to server
		var msg=""+ key.dir + (Controls.isPressed(k) ? 1:0) + t.player.id;
		//console.log("inspace :: Controls.onChange - "+msg);
		t.connection.emit(MESSAGE_TYPE.player_input, msg);
	}, !1);
};

Server.prototype.initialisePlayer = function(id, state){
	var p = new game_player(id, state);
	if(typeof(state) == "undefined"){
		p.setPos(Math.random()*window.innerWidth, Math.random()*window.innerHeight)
			.setAngle(Math.random()*360*Math.PI/180);
		var qs=getQueryString(); //initialise settings from query string
		if(has(qs,"colour")) p.setColour(qs.colour);
		else p.setColour(Math.floor(Math.random()*PLAYER.colour.length));
	}
	console.log("\ninspace :: initialisePlayer - %o", p);
	return p;
};

Server.prototype.initialiseGame = function(state){
	console.log("inspace :: initialiseGame - state %o", state);
	this.game = new game_core(state.id, state.type, false, state);
	this.game.view = [this.localCanvas, this.drawCanvas];
	this.game.ctx = [this.localCanvas.getContext("2d"), this.drawCanvas.getContext("2d")];

	this.clearCanvas();

	if(has(this.game.players, this.player.id)){//Update reference to self
		this.player = this.game.players[this.player.id];
		//this.player.setActive(true);
	}else{
		console.warn("inspace :: initialiseGame "+this.player.sid+" - ERROR Player was not added on the server"); return !1;
	}
};

Server.prototype.clearCanvas = function(){
	this.game.ctx[0].clearRect(0, 0, this.game.view[0].width, this.game.view[0].height);
	this.game.ctx[1].clearRect(0, 0, this.game.view[1].width, this.game.view[1].height);
};

function debug(s){ server.debug(s); }
Server.prototype.debug = function(s){ this.connection.emit(MESSAGE_TYPE.debug, s); };


resizeCanvas = function(){
	console.log("inspace :: resizeCanvas - [%s, %s] %o", window.innerWidth, window.innerHeight, this);
	server.localCanvas.width = window.innerWidth;
	server.localCanvas.height = window.innerHeight;
	server.drawCanvas.width = window.innerWidth;
	server.drawCanvas.height = window.innerHeight;
};

var Controls={
	KEYS:{
		38:{dir:0, player:0, name:"UP"},
		40:{dir:1, player:0, name:"DOWN"},
		37:{dir:2, player:0, name:"LEFT"},
		39:{dir:3, player:0, name:"RIGHT"},

		87:{dir:0, player:1, name:"UP"},
		83:{dir:1, player:1, name:"DOWN"},
		65:{dir:2, player:1, name:"LEFT"},
		68:{dir:3, player:1, name:"RIGHT"}
	},
	_pressed:{},
	isPressed:function(k){ return Controls._pressed[k]; },
	init:function(){
		window.addEventListener("keydown",Controls.keyDown,!1);
		window.addEventListener("keyup",Controls.keyUp,!1);
	},
	keyDown:function(e){
		var k=e.keyCode;
		if(has(Controls.KEYS,k) && !Controls._pressed[k]){
			Controls._pressed[k]=true;
			window.dispatchEvent(new CustomEvent("Controls.onChange", {detail:{key:k},bubbles:false,cancelable:true}));
		}
	},
	keyUp:function(e){
		var k=e.keyCode;
		if(has(Controls.KEYS,k) && Controls._pressed[k]){
			Controls._pressed[k]=false;
			window.dispatchEvent(new CustomEvent("Controls.onChange", {detail:{key:k},bubbles:false,cancelable:true}));
		}
	}
};