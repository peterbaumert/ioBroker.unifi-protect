"use strict";

/*
 * Created with @iobroker/create-adapter v1.21.0
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require("@iobroker/adapter-core");
const https = require("https");

// Load your modules here, e.g.:
// const fs = require("fs");

class UnifiProtect extends utils.Adapter {

	/**
	 * @param {Partial<ioBroker.AdapterOptions>} [options={}]
	 */
	constructor(options) {
		super({
			...options,
			name: "unifi-protect",
		});

		this.writeables = [
			"name",
			"ledSettings.isEnabled",
			"osdSettings.isNameEnabled",
			"osdSettings.isDebugEnabled",
			"osdSettings.isLogoEnabled",
			"osdSettings.isDateEnabled",
			"recordingSettings.mode"
		];

		this.on("ready", this.onReady.bind(this));
		this.on("objectChange", this.onObjectChange.bind(this));
		this.on("stateChange", this.onStateChange.bind(this));
		// this.on("message", this.onMessage.bind(this));
		this.on("unload", this.onUnload.bind(this));
	}

	/**
	 * Is called when databases are connected and adapter received configuration.
	 */
	async onReady() {
		this.subscribeStates("*");
		this.apiAuthBearerToken = await this.getApiAuthBearerToken();
		this.updateData();
		setInterval(() => this.updateData(), 60000);
	}

	/**
	 * Is called when adapter shuts down - callback has to be called under any circumstances!
	 * @param {() => void} callback
	 */
	onUnload(callback) {
		try {
			this.log.info("cleaned everything up...");
			callback();
		} catch (e) {
			callback();
		}
	}

	/**
	 * Is called if a subscribed object changes
	 * @param {string} id
	 * @param {ioBroker.Object | null | undefined} obj
	 */
	onObjectChange(id, obj) {
		if (obj) {
			// The object was changed
			this.log.silly(`object ${id} changed: ${JSON.stringify(obj)}`);
		} else {
			// The object was deleted
			this.log.silly(`object ${id} deleted`);
		}
	}

	/**
	 * Is called if a subscribed state changes
	 * @param {string} id
	 * @param {ioBroker.State | null | undefined} state
	 */
	onStateChange(id, state) {
		if (state) {
			// The state was changed
			this.log.silly(`state ${id} changed: ${state.val} (ack = ${state.ack})`);
			for (let i = 0; i < this.writeables.length; i++) {
				if (id.match(this.writeables[i])) {
					this.changeSetting(id, state.val);
					continue;
				}
			}
		} else {
			// The state was deleted
			this.log.silly(`state ${id} deleted`);
		}
	}

	async renewToken() {
		this.apiAuthBearerToken = this.getApiAuthBearerToken();
	}

	getApiAuthBearerToken() {
		return new Promise((resolve, reject) => {
			const data = JSON.stringify({
				username: this.config.username,
				password: this.config.password
			});
			const options = {
				hostname: this.config.protectip,
				port: this.config.protectport,
				path: "/api/auth",
				method: "POST",
				rejectUnauthorized: false,
				timeout: 10000,
				headers: {
					"Content-Type": "application/json",
					"Content-Length": data.length
				}
			};

			const req = https.request(options, res => {
				if (res.statusCode == 200) {
					resolve(res.headers["authorization"]);
				} else if (res.statusCode == 401 || res.statusCode == 403) {
					this.log.error("Unifi Protect reported authorization failure");
					reject();
				}
			});

			req.on("error", e => {
				this.log.error(e.toString());
				reject();
			});
			req.write(data);
			req.end();
		});
	}

	getApiAccessKey() {

	}

	getCameraList() {
		const options = {
			hostname: this.config.protectip,
			port: this.config.protectport,
			path: `/api/bootstrap`,
			method: "GET",
			rejectUnauthorized: false,
			timeout: 10000,
			headers: {
				"Authorization": "Bearer " + this.apiAuthBearerToken
			}
		};

		const req = https.request(options, res => {
			let data = "";
			res.on("data", d => {
				data += d;
			});
			res.on("end", () => {
				if (res.statusCode == 200) {
					const cameras = JSON.parse(data).cameras;
					this.createOwnChannel("cameras", "Cameras");
					let stateArray = [];
					cameras.forEach(camera => {
						this.createOwnChannel("cameras." + camera.id, camera.name);
						Object.entries(camera).forEach(([key, value]) => {
							stateArray = this.createOwnState("cameras." + camera.id + "." + key, value, key, stateArray);
						});
					});
					this.processStateChanges(stateArray, this);
				} else if (res.statusCode == 401 || res.statusCode == 403) {
					this.log.error("Unifi Protect reported authorization failure");
					this.renewToken();
				}
			});
		});

		req.on("error", e => {
			this.log.error(e.toString());
		});
		req.end();
	}

	getMotionEvents() {
		const now = Date.now();
		const eventStart = now - (86400 * 1000);
		const eventEnd = now + (10 * 1000);

		const options = {
			hostname: this.config.protectip,
			port: this.config.protectport,
			path: `/api/events?end=${eventEnd}&start=${eventStart}&type=motion`,
			method: "GET",
			rejectUnauthorized: false,
			timeout: 10000,
			headers: {
				"Authorization": "Bearer " + this.apiAuthBearerToken
			}
		};

		const req = https.request(options, res => {
			let data = "";
			res.on("data", d => {
				data += d;
			});
			res.on("end", () => {
				if (res.statusCode == 200) {
					const motionEvents = JSON.parse(data);
					this.createOwnChannel("motions", "Motion Events");
					this.deleteOldMotionEvents(motionEvents);
					this.addMotionEvents(motionEvents);
				} else if (res.statusCode == 401 || res.statusCode == 403) {
					this.log.error("Unifi Protect reported authorization failure");
					this.renewToken();
				} else {
					this.log.error("Status Code: " + res.statusCode);
				}
			});
		});

		req.on("error", e => {
			this.log.error(e.toString());
		});
		req.end();
	}

	updateData() {
		this.getCameraList();
		this.getMotionEvents();
	}

	changeSetting(state, val) {
		const found = state.match(/cameras\.(?<cameraid>[a-z0-9]+)\.(?<parent>[a-z]+)\.(?<setting>[a-z]+)/i);
		const found_root = state.match(/cameras\.(?<cameraid>[a-z0-9]+)\.(?<setting>[a-z]+)$/i);
		let parent = "";
		let setting = "";
		let cameraid = "";
		let data = "";

		if (found != null && found.groups !== undefined) {
			parent = found.groups.parent;
			setting = found.groups.setting;
			cameraid = found.groups.cameraid;
			data = JSON.stringify({
				[parent]: {
					[setting]: val,
				}
			});
		} else if (found_root != null && found_root.groups !== undefined) {
			setting = found_root.groups.setting;
			cameraid = found_root.groups.cameraid;
			parent = cameraid;
			data = JSON.stringify({
				[setting]: val
			});
		} else {
			return;
		}

		const options = {
			hostname: this.config.protectip,
			port: this.config.protectport,
			path: `/api/cameras/${cameraid}`,
			method: "PATCH",
			rejectUnauthorized: false,
			timeout: 10000,
			headers: {
				"Authorization": "Bearer " + this.apiAuthBearerToken,
				"Content-Type": "application/json",
				"Content-Length": data.length
			}
		};

		this.log.error(`/api/cameras/${cameraid}`);

		const req = https.request(options, res => {
			if (res.statusCode == 200) {
				this.log.debug(`Camera setting ${parent}.${setting} set to ${val}`);
			} else {
				this.log.error(`Status Code: ${res.statusCode}`);
			}
		});

		req.on("error", e => {
			this.log.error(e.toString());
		});
		req.write(data);
		req.end();
	}

	processStateChanges(stateArray, that, callback) {
		if (!stateArray || stateArray.length === 0) {
			if (typeof (callback) === "function")
				callback();

			// clear the array
			stateArray = [];
		}
		else {
			const newState = stateArray.shift();
			that.getState(newState.name, function (err, oldState) {
				// @ts-ignore
				if (oldState === null || newState.val != oldState.val) {
					that.setState(newState.name, { ack: true, val: newState.val }, function () {
						setTimeout(that.processStateChanges, 0, stateArray, that, callback);
					});
				}
				else
					setTimeout(that.processStateChanges, 0, stateArray, that, callback);
			});
		}
	}

	/**
 	* Function to create a state and set its value
 	* only if it hasn't been set to this value before
 	*/
	createOwnState(name, value, desc, stateArray) {

		if (typeof (desc) === "undefined")
			desc = name;

		if (Array.isArray(value))
			value = value.toString();

		if (typeof value === "object" && value !== null) {
			this.createOwnChannel(name);
			Object.entries(value).forEach(([key, value]) => {
				stateArray = this.createOwnState(name + "." + key, value, key, stateArray);
			});
			return stateArray;
		}

		let write = false;
		for (let i = 0; i < this.writeables.length; i++) {
			if (name.match(this.writeables[i])) {
				write = true;
				continue;
			}
		}

		let common = {
			name: desc,
			type: typeof (value),
			read: true,
			write: write
		};

		if (name.match("recordingSettings.mode") != null) {
			common = {
				name: desc,
				type: typeof (value),
				read: true,
				write: true,
				states: {
					"always": "always",
					"never": "never",
					"motion": "motion"
				}
			};
		}

		this.setObjectNotExists(name, {
			type: "state",
			common: common,
			native: { id: name }
		});

		if (typeof (value) !== "undefined") {
			stateArray.push({ name: name, val: value });
		}

		return stateArray;

	}

	/**
	 * Function to create a channel
	 */
	createOwnChannel(name, desc) {

		if (typeof (desc) === "undefined")
			desc = name;

		this.setObjectNotExists(name, {
			type: "channel",
			common: {
				name: desc
			},
			native: {}
		});
	}

	addMotionEvents(motionEvents) {
		let stateArray = [];
		motionEvents.forEach(motionEvent => {
			this.createOwnChannel("motions." + motionEvent.camera + "." + motionEvent.id, motionEvent.score);
			Object.entries(motionEvent).forEach(([key, value]) => {
				stateArray = this.createOwnState("motions." + motionEvent.camera + "." + motionEvent.id + "." + key, value, key, stateArray);
			});
		});
		Object.entries(motionEvents[motionEvents.length - 1]).forEach(([key, value]) => {
			stateArray = this.createOwnState("motions." + motionEvents[motionEvents.length - 1].camera + ".lastMotion." + key, value, key, stateArray);
		});
		this.processStateChanges(stateArray, this);
	}

	deleteOldMotionEvents(currentMotionEvents) {
		const that = this;
		that.getChannelsOf("motions", function (err, channels) {
			if (channels !== undefined) {
				channels.forEach(channel => {
					const found = channel._id.match(/motions\.(?<cameraid>[a-z0-9]+)\.(?<motionid>[a-z0-9]+)$/i);
					if (found != null && found.groups !== undefined) {
						//check if in currentMotionEvents
						let isin = false;
						for (let i = 0; i < currentMotionEvents.length; i++) {
							if(currentMotionEvents[i].camera == found.groups.cameraid && currentMotionEvents[i].id == found.groups.motionid) {
								isin = true;
								break;
							}
						}
						if (!isin) {
							that.deleteChannel("motions","motions."+found.groups.cameraid+"."+found.groups.motionid);
						}
					}
				});
			}
		});
	}

	// /**
	//  * Some message was sent to this instance over message box. Used by email, pushover, text2speech, ...
	//  * Using this method requires "common.message" property to be set to true in io-package.json
	//  * @param {ioBroker.Message} obj
	//  */
	// onMessage(obj) {
	// 	if (typeof obj === "object" && obj.message) {
	// 		if (obj.command === "send") {
	// 			// e.g. send email or pushover or whatever
	// 			this.log.info("send command");

	// 			// Send response in callback if required
	// 			if (obj.callback) this.sendTo(obj.from, obj.command, "Message received", obj.callback);
	// 		}
	// 	}
	// }

}

// @ts-ignore parent is a valid property on module
if (module.parent) {
	// Export the constructor in compact mode
	/**
	 * @param {Partial<ioBroker.AdapterOptions>} [options={}]
	 */
	module.exports = (options) => new UnifiProtect(options);
} else {
	// otherwise start the instance directly
	new UnifiProtect();
}