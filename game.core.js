/*	The main update loop

Runs on requestAnimationFrame, which falls back to a setTimeout loop on the server
Code below is from Three.js, and sourced from links below
http://paulirish.com/2011/requestanimationframe-for-smart-animating
http://my.opera.com/emoller/blog/2011/12/20/requestanimationframe-for-smart-er-animating */
var _framerate = 60,//run the local game at 16ms/60hz
	_frametime = Math.floor(1000.0/_framerate),
	_physics_framerate = 60,
	_physics_frametime = Math.floor(1000.0/_physics_framerate), //run the server physics at 15ms/65hz
	b2d,
	Physics,
	isServer = (typeof(global)!=="undefined");

if(isServer){
	_framerate = 22;//on server we run at 45ms/22hz
	_frametime = Math.floor(1000.0/_framerate);
}

(function(){//requestAnimationFrame polyfill by Erik Möller, fixes from Paul Irish and Tino Zijdel
	var lastTime=0,
		vendors=["ms","moz","webkit","o"];
	for(var i=vendors.length-1; i>=0 && !window.requestAnimationFrame; --i){
		window.requestAnimationFrame = window[vendors[i] + "RequestAnimationFrame"];
		window.cancelAnimationFrame = window[vendors[i] + "CancelAnimationFrame"] || window[vendors[i] + "CancelRequestAnimationFrame"];
	}
	if(!window.requestAnimationFrame){
		window.requestAnimationFrame = function(callback,e){
			var currTime = Date.now(),
				timeToCall = Math.max(0, _frametime - (currTime - lastTime)),
				id = window.setTimeout(function(){ callback(currTime + timeToCall); }, timeToCall);
			lastTime = currTime + timeToCall;
			return id;
		};
	}
	if(!window.cancelAnimationFrame)
		window.cancelAnimationFrame = function(id){ clearTimeout(id); };
}());


var MESSAGE_TYPE={
	connected_to_server			:"c",
	disconnected_from_server	:"d",
	join_game					:"j",
	//watch_game					:"g",
	player_active				:"p",
	player_added				:"n",
	player_removed				:"r",
	//view_active					:"v",
	player_input				:"i",
	server_state_update			:"u",
	debug						:"z"
};

var PLAYER={
	//speedMax	:100,
	accel		:50,
	decel		:-50,
	reverse		:-50,
	drag		:0.08,

	density		:1.0,
	friction	:0.2,
	restitution	:0.5,

	maxTurn		:45 *(Math.PI/180),//radians 360=2PI
	turnSpeed	:4.5,
	skid		:1.2,

	scale		:40,
	size		:{width:123, height:80},
	wheel		:{x:0.13, y:0.15, width:0.25, height:0.26},
	colour		:["255,0,30,.5","255,100,0,.5","200,0,190,.5","0,200,30,.5","0,30,250,.5","250,200,0,.6"]//red,orange,purple,green,blue,yellow
};
PLAYER.pScale = 1/PLAYER.scale;
PLAYER.size.hw = PLAYER.size.width/2;
PLAYER.size.hh = PLAYER.size.height/2;


/*	The game_core class

This gets created on both server and client. Server creates one for each game that is hosted, and client creates one for itself to play the game. */
var game_core=function(id, gameType, isServer, state){
	this.id				= id;
	this.type			= gameType;
	this.isServer		= isServer;
	this.playersMax		= 6;
	this.playersCount	= 0;
	this.players		= {};
	this.active			= !1;
	this.worldSize		= [1032, 610];

	this._pdt = 0.0001;					//The physics update delta time
	this._pdte = new Date().getTime();	//The physics update last delta time
	this.physics_timer = -1;
	this.local_time = 0.016;			//The local time for precision on server and client
	this.local_timer = -1;
	this._dt = new Date().getTime();	//The local timer delta
	this._dte = new Date().getTime();	//The local timer last frame time

	//restore from state
	if(typeof(state) != "undefined"){
		console.log(state);
		for(var i in state){if(has(state,i) && has(this,i) && i!="players"){
			this[i] = state[i];
		}}
		if(has(state,"players")){
			for(var p,j=state.players.length-1; j>=0; j--){
				p = state.players[j];
				if(has(p,"id")){
					this.addPlayer( new game_player(p.id, p) );
				}
			}
		}
	}

	if(!this.isServer){//player
		this.server_updates = [];
		this.server_time = 0.01;

		/*this.net_latency = 0.001;		//the latency between the client and the server (ping/2)
		this.net_ping = 0.001;			//The round trip time from here to the server,and back
		this.client_createPing();*/

	}else{//server
		this.server_time = 0;
		this.laststate = {};

		//PHYSICS
		this.physics = Physics.init();
		Physics.createWalls({width:this.worldSize[0], height:this.worldSize[1]});
	}

	if(this.active){
		this.active = false;
		this.checkActive();
	}
};

game_core.prototype.getString = function(){
	var s=[
		this.id,
		this.type,
		this.active*1,
		this.playersMax,
		this.worldSize[0], this.worldSize[1],
	];
	if(this.playersCount>0){
		for(var p in this.players){if(has(this.players,p)){
			s[s.length] = this.players[p].getString();
		}}
	}
	return s.join("~");
};
game_core.parseString = function(s){
	s = s.split("~");
	if(s.length < 4){ console.warn("\t game_core.parseString :: ERROR - Invalid string "+s); return !1; }

	var i=0,
	o={
		id: s[i++],
		type :s[i++],
		active: s[i++]==1,
		playersMax: parseInt(s[i++]),
		worldSize:[ s[i++]*1, s[i++]*1 ]
	};
	if(s.length>i){//include players
		o.players=[];
		for(var j=s.length-1; j>=i; j--){
			o.players[o.players.length] = game_player.parseString(s[j]);
		}
	}
	return o;
};

game_core.prototype.addPlayer = function(player){
	console.log("\t game_core.addPlayer :: "+ player.id);
	this.players[player.id] = player;
	this.playersCount++;
	player.game = this;

	//PHYSICS
	//if(player.pos[0] > this.worldSize[0]) player.pos[0] = this.worldSize[0];
	//if(player.pos[1] > this.worldSize[1]) player.pos[1] = this.worldSize[1];
	if(this.isServer) player.createPhysics(Physics.world);

	return player;
};
game_core.prototype.removePlayer = function(player){
	console.log("\t game_core.removePlayer :: "+ player.id);
	if(has(this.players, player.id)){
		if(this.isServer) this.players[player.id].destroyPhysics(Physics.world);//PHYSICS
		this.players[player.id].setActive(false);
		delete this.players[player.id];
		this.playersCount--;
	}
	if(has(player,"game")) delete player.game;
};

game_core.prototype.checkActive = function(){
	var a=false;
	if(this.playersCount > 0 && has(this,"players")){
		for(var p in this.players){if(has(this.players,p)){
			if(this.players[p].active){
				a=true;
				break;
			}
		}}
	}
	console.log("\t game_core.checkActive :: active: "+this.active+", set: "+a);
	this.active = a;

	if(a){ this.stop_update(); this.start_update(); }
	else this.stop_update();

	return a;
};

game_core.prototype.start_update = function(){//PHYSICS
	//create timer
	this._dte = new Date().getTime();
	this.local_timer = setInterval(this.local_timer_update.bind(this), 4);

	//create physics timer on server
	if(this.isServer){
		this._pdte = new Date().getTime();
		this.physics_timer = setInterval(this.physics_timer_update.bind(this), _physics_frametime);
	}

	//start the update loop
	this.update(new Date().getTime());
};
game_core.prototype.stop_update = function(){//PHYSICS
	window.cancelAnimationFrame(this.updateid);//For the server, we need to cancel the setTimeout that the polyfill creates
	clearInterval(this.local_timer);

	if(this.isServer) clearInterval(this.physics_timer);
};

game_core.prototype.local_timer_update = function(){
	this._dt = new Date().getTime() - this._dte;
	this._dte = new Date().getTime();
	this.local_time += this._dt/1000.0;
};
game_core.prototype.physics_timer_update = function(){//PHYSICS
	this._pdt = (new Date().getTime() - this._pdte)/1000.0;
	this._pdte = new Date().getTime();
	this.update_physics();
};

game_core.prototype.update = function(t){
	this.dt = this.lastframetime ? ((t - this.lastframetime)/1000.0).fixed() : 0.016;//Calculate delta
	this.lastframetime = t;//Store the last frame time

	if(!this.isServer) this.client_update();
	else this.server_update();

	this.updateid = window.requestAnimationFrame(this.update.bind(this), this.viewport);//schedule the next update
};
game_core.prototype.server_update = function(){//PHYSICS
	//console.log("\t game_core.prototype.server_update");
	var p,pos;
	this.server_time = this.local_time;//Update the state of our local clock to match the timer

	//Make a snapshot of the current state, for updating the clients
	this.laststate = [
		this.server_time.fixed()//our current local time on the server
	];
	if(this.playersCount>0){
		for(p in this.players){if(has(this.players,p)){
			if(this.players[p].active && has(this.players[p],"body")){
				//get offset world pos
				pos = this.players[p].body.GetWorldPoint({x:PLAYER.size.hw*PLAYER.pScale, y:PLAYER.size.hh*PLAYER.pScale});
				
				//catch invalid physics
				if(isNaN(pos.x) || isNaN(pos.y)){
					console.error("\t game_core.server_update :: \n\t INVALID " +this.players[p].id);
					this.players[p].setActive(false);
					break;
				}
				
				//update players vars
				this.players[p].setPos(pos.x*PLAYER.scale, pos.y*PLAYER.scale)
					.setAngle(parseFloat(this.players[p].body.GetAngle()))
					.wheelAngle = this.players[p].fJoint.GetJointAngle();
				
				//push to server snapshot
				this.laststate[this.laststate.length] = this.players[p].getPosString();
			}
		}}
	}

	//Send the snapshot to the players
	for(p in this.players){if(has(this.players,p) && has(this.players[p],"client")){
		this.players[p].client.volatile.emit(MESSAGE_TYPE.server_state_update, this.laststate.join("~"));
	}}
};
game_core.prototype.client_update = function(){
	//console.log("\t game_core.prototype.client_update");
	if(this.server_updates.length>0){
		var s=this.server_updates[this.server_updates.length-1], l=s.length, i,j,p;
		for(i=1; i<l; i++){
			p = game_player.parseString(s[i]);
			if(p!==false && has(p,"id") && has(this.players,p.id)){
				//update positions from server
				this.players[p.id].setPos(p.pos[0], p.pos[1])
					.setAngle(p.angle)
					.wheelAngle = p.wheelAngle;

				//this.players[p.id].lastPos = this.players[p.id].pos;
				//this.players[p.id].lastAngle = this.players[p.id].angle;
				//update positions from server
				/*for(j in p){if(has(this.players[p.id],j)){
					this.players[p.id][j] = p[j];
				}else{ console.warn("\t game_core.client_update :: ERROR property doesn't exist %o",j); }}*/
			}else{
				console.warn("\t game_core.client_update :: ERROR Player not found or inactive %o %s %s %s %s",p,p!==false,has(p,"id"),has(this.players,p.id));
			}
		}

		if(this.server_updates.length > 2) this.server_updates.splice(0, 1);
	}else{ console.warn("\t game_core.client_update :: server_updates - ERROR No updates in buffer"); return !1; }

	//run local update
	//update();

	//draw to canvas
	this.draw();
};

game_core.prototype.update_physics = function(){//PHYSICS
	Physics.world.Step(this._pdt, 8, 8);
	Physics.world.ClearForces();

	var p,i;
	for(i in this.players){if(has(this.players,i)){
		p = this.players[i];
		if(!p.active) continue;

		//apply inputs
		var v = p.body.GetLinearVelocity().LengthSquared(),
			f = p.fWheel.GetWorldVector({x:1,y:0});
		if(p.inputs[0]){
			f.Multiply(PLAYER.accel);
			p.fWheel.ApplyForce(f, p.fWheel.GetWorldCenter());
		}else if(p.inputs[1]){
			if(v > 0) f.Multiply(PLAYER.decel);
			else f.Multiply(PLAYER.reverse);
			p.fWheel.ApplyForce(f, p.fWheel.GetWorldCenter());
		}

		//steering
		var mSpeed = (PLAYER.maxTurn * (p.inputs[3] - p.inputs[2])) - p.fJoint.GetJointAngle();
		p.fJoint.SetMotorSpeed(mSpeed * PLAYER.turnSpeed);
		Physics.applyWheelFriction(p.fWheel);
		Physics.applyWheelFriction(p.rWheel);
	}}
};

/*game_core.prototype.client_createPing = function(){
	//Set a ping timer to 1 second, to maintain the ping/latency between client and server and calculated roughly how our connection is doing
	setInterval(function(){
		this.socket.send("p." + new Date().getTime());
	}.bind(this), 1000);
};
game_core.prototype.client_onPing = function(msg){
	this.net_ping = new Date().getTime() - parseFloat(msg);
	this.net_latency = this.net_ping / 2;
};*/

game_core.prototype.draw = function(){
	if(!has(this,"view") || !has(this,"ctx")){ console.warn("\t game_core.draw :: no canvas"); return !1; }
	//clear canvas
	this.ctx[0].clearRect(0, 0, this.view[0].width, this.view[0].height);

	//get render region
	this.ctx[0].strokeStyle="#000";
	this.ctx[0].lineWidth=2;
	this.ctx[0].strokeRect(0,0,this.worldSize[0],this.worldSize[1]);

	//get tracking object

	//draw each player
	for(var p in this.players){if(has(this.players,p)){
		this.players[p].draw(this.ctx);
	}}
};

game_core.prototype.broadcast = function(type, msg, id){
	id = id||0;
	if(this.playersCount > 0){
		for(var p in this.players){
			if(has(this.players,p) && this.players[p].id != id && has(this.players[p],"client")){
				this.players[p].client.emit(type, msg);
			}
		}
	}
};


/*	Player functions */
var game_player = function(id, state){
	this.id			= id;
	this.active		= false;
	this.inputs		= [!1,!1,!1,!1];
	this.colour		= 0;

	this.pos		= [0,0];
	this.lastPos	= [0,0];
	this.angle		= 0.0;
	this.lastAngle	= 0.0;
	this.wheelAngle	= 0.0;
	this.penLoc		= [0,0];

	//restore from state
	if(typeof(state) != "undefined"){
		for(var i in state){if(has(this,i)){ this[i]=state[i]; }}
	}
};

game_player.prototype.getGame = function(){
	if(has(this,"game")) return this.game;
	return false;
};
game_player.prototype.getPosString = function(){
	var s=[
		this.id,
		this.pos[0].fixed(2)||0, this.pos[1].fixed(2)||0,
		parseFloat(this.angle).fixed(3)||0,
		parseFloat(this.wheelAngle).fixed(2)||0
	];
	return s.join("|");
};
game_player.prototype.getString = function(){
	var s=[
		this.getPosString(),
		this.active*1,
		this.colour,
		this.inputs[0]*1, this.inputs[1]*1, this.inputs[2]*1, this.inputs[3]*1
	];
	return s.join("|");
};
game_player.parseString = function(s){
	s = s.split("|");
	if(s.length < 2){ console.warn("\t game_player.parseString :: ERROR - Invalid string "+s); return !1; }
	var i=0,
	o={
		id: s[i++],
		pos: [s[i++]*1, s[i++]*1],
		angle: [s[i++]*1],
		wheelAngle: [s[i++]*1]
	};
	if(i<s.length){
		o.active= s[i++]==1;
		o.colour= s[i++];
		o.inputs= [s[i++]==1, s[i++]==1, s[i++]==1, s[i++]==1];
	}
	return o;
};

game_player.prototype.setPos = function(x,y){
	this.lastPos[0]=this.pos[0];
	this.lastPos[1]=this.pos[1];
	this.pos[0]=x;
	this.pos[1]=y;
	return this;
};
game_player.prototype.setAngle = function(a){
	this.lastAngle=this.angle;
	this.angle=a;
	return this;
};
game_player.prototype.setColour = function(c){
	console.log("\t game_player.setColour :: id: "+ this.id +" c: "+ c);
	if(isNaN(c)){
		for(var i=PLAYER.colour.length-1;i>=0;i--){
			if(c==PLAYER.colour[i]){
				c = i;
				break;
			}
		}
	}
	this.colour = c;
	return this;
};
game_player.prototype.setActive = function(a){
	console.log("\t game_player.setActive :: active: "+a);
	this.active = a;
	if(has(this,"body")) this.body.SetActive(a);
	if(has(this,"rWheel")) this.rWheel.SetActive(a);
	if(has(this,"fWheel")) this.fWheel.SetActive(a);
	if(has(this,"game")){
		this.game.checkActive();	
		if(has(this,"client")){
			this.game.broadcast(MESSAGE_TYPE.player_active, (a*1)+this.id);
			//this.client.emit(MESSAGE_TYPE.server_state_update, this.laststate.join("~"));
		}
	}
	
	return this;
};
game_player.prototype.setInput = function(d,a){
	if(d<0 || d>3){ console.warn("\t game_player.setInput - ERROR Input out of range "+d); return !1; }
	//console.log("\t game_player.setInput - "+ d + (a*1) +" "+ this.id);

	this.inputs[d] = a==true;
	return this;
};

game_player.prototype.createPhysics = function(world){//PHYSICS
	var s = PLAYER.pScale,
		w = PLAYER.wheel,
		ps = { width: PLAYER.size.width*s, height: PLAYER.size.height*s, hw:PLAYER.size.width*s/2, hh:PLAYER.size.height*s/2 },
		fixDef = Physics.fixDef;

	var safePos = {x:this.pos[0]*s, y:this.pos[1]*s};
	console.log("\t game_player.createPhysics :: safePos: [%s, %s]], worldSize: [%s, %s]",safePos.x.fixed(8),safePos.y.fixed(8), (this.game.worldSize[0]*s).fixed(8), (this.game.worldSize[1]*s).fixed(8));
	safePos = Physics.getCleanStart(safePos, {x:this.game.worldSize[0]*s, y:this.game.worldSize[1]*s}, 0);
	this.pos[0] = safePos.x / s;
	this.pos[1] = safePos.y / s;

	//create body
	var bodyDef = new b2d.b2BodyDef();
	bodyDef.linearDamping = PLAYER.drag /s;
	bodyDef.angularDamping = PLAYER.drag /s;
	bodyDef.type = b2d.b2Body.b2_dynamicBody;
	this.body = world.CreateBody(bodyDef);

	//create body fixtures
	//back left wheel
	fixDef.shape = b2d.b2PolygonShape.AsOrientedBox(
		ps.width * w.width/2,
		ps.height * w.height/2,
		{	x: ps.width * w.x,
			y: ps.height * w.y }
	);
	this.body.CreateFixture(fixDef);

	//back right wheel
	fixDef.shape = b2d.b2PolygonShape.AsOrientedBox(
		ps.width * w.width/2,
		ps.height * w.height/2,
		{	x: ps.width * w.x,
			y: ps.height * (1-w.y) }
	);
	this.body.CreateFixture(fixDef);

	//body
	fixDef.shape = b2d.b2PolygonShape.AsArray([
		{x:ps.width*0.088,	y:ps.height*0.332},
		{x:ps.width*0.52,	y:ps.height*0.088},
		{x:ps.width*0.732,	y:ps.height*0.088},
		{x:ps.width*0.732,	y:ps.height*(1-0.088)},
		{x:ps.width*0.52,	y:ps.height*(1-0.088)},
		{x:ps.width*0.088,	y:ps.height*(1-0.332)}
	]);
	this.body.CreateFixture(fixDef);

	//pen
	fixDef.shape = b2d.b2PolygonShape.AsArray([
		{x:ps.width*0.732,	y:ps.height*0.375},
		{x:ps.width*0.845,	y:ps.height*0.375},
		{x:ps.width,		y:ps.hh},
		{x:ps.width*0.845,	y:ps.height*(1-0.375)},
		{x:ps.width*0.732,	y:ps.height*(1-0.375)}
	]);
	this.body.CreateFixture(fixDef);

	var v = {x:this.pos[0]*s-ps.hw, y:this.pos[1]*s-ps.hh};
	this.body.SetPosition(v);


	//create wheels
	function makeWheel(){
		fixDef.shape = new b2d.b2PolygonShape();
		fixDef.shape.SetAsBox(ps.width*w.width/2, ps.height*w.height/2);
		var wDef = new b2d.b2BodyDef();
		wDef.type = b2d.b2Body.b2_dynamicBody;
		var b = world.CreateBody(wDef);
		b.CreateFixture(fixDef).SetSensor(true);
		return b;
	}

	this.rWheel = makeWheel();
	this.rWheel.SetPosition({x:v.x+ps.width*w.x, y:v.y+ps.hh});

	this.fWheel = makeWheel();
	this.fWheel.SetPosition({x:v.x+ps.width*0.626, y:v.y+ps.hh});


	//attach wheels
	var rJointDef = new b2d.b2WeldJointDef();
	rJointDef.Initialize(this.body, this.rWheel, this.rWheel.GetWorldCenter());
	this.rJoint = world.CreateJoint(rJointDef);

	var fJointDef = new b2d.b2RevoluteJointDef();
	fJointDef.Initialize(this.body, this.fWheel, this.fWheel.GetWorldCenter());
	fJointDef.enableLimit = true;
	fJointDef.lowerAngle = 0-PLAYER.maxTurn;
	fJointDef.upperAngle = PLAYER.maxTurn;
	fJointDef.enableMotor = true;
	fJointDef.maxMotorTorque = 100;
	this.fJoint = world.CreateJoint(fJointDef);

	this.body.SetAngle(this.angle);

	console.log("\t game_player.createPhysics :: created - pos: [%s, %s], angle: %s", this.body.GetPosition().x.fixed(8), this.body.GetPosition().y.fixed(8), parseFloat(this.body.GetAngle()).fixed(8));

	return this;
};
game_player.prototype.destroyPhysics = function(world){//PHYSICS
	if(has(this,"body")){
		world.DestroyJoint(this.rJoint);
		delete this.rJoint;
		world.DestroyJoint(this.fJoint);
		delete this.fJoint;
		world.DestroyBody(this.rWheel);
		delete this.rWheel;
		world.DestroyBody(this.fWheel);
		delete this.fWheel;
		world.DestroyBody(this.body);
		delete this.body;
	}
	return this;
};

game_player.prototype.destroy = function(){
	if(this.active) this.setActive(false);
	if(this.getGame()) this.game.removePlayer(this);
	if(has(this,"client")) delete this.client;
	if(has(this,"img")) delete this.img;
	return this;
};

game_player.prototype.draw = function(ctx){
	if(this.active){
		var c = ctx[0],
			colour = "rgba("+ (isNaN(this.colour) ? this.colour : PLAYER.colour[this.colour]) +")";
		c.save();
		c.translate(this.pos[0], this.pos[1]);
		c.rotate(this.angle);

		//draw colour behind body
		c.fillStyle=colour;//Set the color for this player
		c.fillRect(0-PLAYER.size.hw, 0-PLAYER.size.hh, PLAYER.size.width, PLAYER.size.height);
		c.closePath();

		//draw lines for wheel indication
		c.translate(PLAYER.size.width*0.126, 0-PLAYER.size.hh);
		c.rotate(this.wheelAngle);
		c.beginPath();
		c.lineWidth=3;
		c.strokeStyle=colour;
		c.moveTo(-20, 0);
		c.lineTo(20, 0);
		c.stroke();
		c.rotate(0-this.wheelAngle);
		c.translate(0, PLAYER.size.height);
		c.rotate(this.wheelAngle);
		c.moveTo(-20, 0);
		c.lineTo(20, 0);
		c.stroke();
		c.restore();

		//draw car body image
		if(has(this,"img")){
			c.save();
			c.translate(this.pos[0], this.pos[1]);
			c.rotate(this.angle);
			c.rotate(90*Math.PI/180);
			c.drawImage(this.img,-(this.img.width/2),-(this.img.height/2));
			c.restore();
		}else{//load image
			this.img = new Image();
			this.img.src = "/img/car.png";
		}

		//draw pen line on 2nd canvas
		c = ctx[1];
		var newLoc = [
				this.pos[0] + (PLAYER.size.hw * Math.cos(this.angle)),
				this.pos[1] + (PLAYER.size.hw * Math.sin(this.angle))
			],
			dX = newLoc[0]-this.penLoc[0],
			dY = newLoc[1]-this.penLoc[1],
			d = dX*dX + dY*dY;
		if(d<1000){//don't draw if distance squared is greater than 1000
			c.beginPath();
			c.strokeStyle=colour;
			c.lineWidth=2;
			c.moveTo(this.penLoc[0], this.penLoc[1]);
			c.lineTo(newLoc[0], newLoc[1]);
			c.stroke();
		}
		this.penLoc = newLoc;
	}
	return this;
};



/* Physics functions */
Physics = {
	world:{},
	fixDef:{},
	walls:[],
};
Physics.init = function(){
	//Init Physics on first time
	if(typeof(b2d) == "undefined") b2d = require("box2dnode");

	//Create default fixture
	this.fixDef = new b2d.b2FixtureDef();
	this.fixDef.density = PLAYER.density;
	this.fixDef.friction = PLAYER.friction;
	this.fixDef.restitution = PLAYER.restitution;

	//Create world
	this.world = new b2d.b2World(
		new b2d.b2Vec2(0,0), // gravity
		false // dosleep
	);
	return this.world;
};
Physics.createWalls = function(size){//add walls
	var t=2;
	for(var def, fix=this.fixDef, i=0; i<4; i++){
		fix.shape = new b2d.b2PolygonShape();
		if(i<2) fix.shape.SetAsBox(size.width*PLAYER.pScale, t);
		else fix.shape.SetAsBox(t, size.height*PLAYER.pScale);
		def = new b2d.b2BodyDef();
		def.type = b2d.b2Body.b2_staticBody;
		this.walls[i] = this.world.CreateBody(def);
		this.walls[i].CreateFixture(fix);
	}
	this.walls[0].SetPosition({x:0, y:-t});
	this.walls[1].SetPosition({x:0, y:size.height*PLAYER.pScale+t});
	this.walls[2].SetPosition({x:-t, y:0});
	this.walls[3].SetPosition({x:size.width*PLAYER.pScale+t, y:0});
};
Physics.applyWheelFriction = function(w){
	var v = w.GetWorldVector({x:0,y:1});
	v.Multiply(b2d.b2Math.Dot(v, w.GetLinearVelocity()));
	if(v.Length() > PLAYER.skid){
		v.Multiply(PLAYER.skid / v.Length());
	}
	v.NegativeSelf();
	w.ApplyImpulse(v, w.GetWorldCenter());
	return w;
};
Physics.getCleanStart = function(p, b, l){
	var s = (PLAYER.size.width>PLAYER.size.height ? PLAYER.size.width : PLAYER.size.height) *PLAYER.pScale/2,
		isSafe = (!isNaN(p.x) && !isNaN(p.y) && p.x>s && p.x<b.x-s && p.y>s && p.y<b.y-s);

	if(isSafe){
		var aabb = new b2d.b2AABB(),
			callback=function(fixture){
				if(!fixture.IsSensor()){
					var clip = fixture.GetBody().GetPosition();
					if(!isNaN(clip.x) && !isNaN(clip.y)){
						console.log("\t\t Physics.getCleanStart :: pos: [%s, %s], clip: [%s, %s]", clip.x.fixed(6), clip.y.fixed(6), p.x.fixed(6), p.y.fixed(6));
						isSafe = false;
						return false;
					}
				}
				return true;
			};
		aabb.lowerBound.Set(p.x-s, p.y-s);
		aabb.upperBound.Set(p.x+s, p.y+s);
		this.world.QueryAABB(callback, aabb);
	}
	if(!isSafe){
		p.x = s + (Math.random() * (b.x-s-s));
		p.y = s + (Math.random() * (b.y-s-s));
		if(l<40) //avoid infinite loops
			p = Physics.getCleanStart(p, b, l+1);
		else
			p = {x:0, y:0};
	}
	return p;
};


/*	Helper functions */
Number.prototype.fixed = function(n){ n=n||3; return parseFloat(this.toFixed(n)); };// (4.22208334636).fixed(n) will return fixed point value to n places, default n=3
debounce = function(f,w){ var t;return function(){var c=this,a=arguments,l=function(){t=null;f.apply(c,a);};clearTimeout(t);t=setTimeout(l,w||200);}; };//Queues events so only the last event triggered will be called after a delay
getQueryString = function(){ var r={},q=location.search.slice(1),e=/([^&=]+)=([^&]*)/g,m;while(!!(m=e.exec(q))){r[decodeURIComponent(m[1]+"")]=decodeURIComponent((m[2]+"").replace(/\+/g,"%20"));}return r; };//Returns the split querystring
has = function(o,p){ return Object.prototype.hasOwnProperty.call(o,p); };//Proper checking of valid parameters
if(!Object.keys)Object.keys=function(obj){ var keys=[],k;for(k in obj){if(Object.prototype.hasOwnProperty.call(obj,k))keys.push(k);}return keys; };//Support for older browsers

if(isServer){//server side we set these classes to global type
	module.exports = global.MESSAGE_TYPE = MESSAGE_TYPE;
	module.exports = global.game_player = game_player;
	module.exports = global.game_core = game_core;
}
