/*
 * vim: ts=2:sw=2:expandtab
 */

/* eslint-disable more/no-then */

const btoa = require("btoa");
const libsignal = require("@throneless/libsignal-protocol");
const errors = require("./errors.js");
const Message = require("./message.js");
const protobuf = require("./protobufs.js");
const Content = protobuf.lookupType("signalservice.Content");
const DataMessage = protobuf.lookupType("signalservice.DataMessage");

class OutgoingMessage {
  constructor(server, store, timestamp, numbers, message, silent, callback) {
    if (message.$type === DataMessage) {
      const content = Content.create();
      content.dataMessage = message;
      // eslint-disable-next-line no-param-reassign
      message = content;
    }
    this.server = server;
    this.store = store;
    this.timestamp = timestamp;
    this.numbers = numbers;
    this.message = message; // ContentMessage proto
    this.callback = callback;
    this.silent = silent;

    this.numbersCompleted = 0;
    this.errors = [];
    this.successfulNumbers = [];
  }

  numberCompleted() {
    this.numbersCompleted += 1;
    if (this.numbersCompleted >= this.numbers.length) {
      this.callback({
        successfulNumbers: this.successfulNumbers,
        errors: this.errors
      });
    }
  }

  registerError(number, reason, error) {
    if (!error || (error.name === "HTTPError" && error.code !== 404)) {
      // eslint-disable-next-line no-param-reassign
      error = new errors.OutgoingMessageError(
        number,
        Content.encode(this.message).finish(),
        this.timestamp,
        error
      );
    }

    // eslint-disable-next-line no-param-reassign
    error.number = number;
    // eslint-disable-next-line no-param-reassign
    error.reason = reason;
    this.errors[this.errors.length] = error;
    this.numberCompleted();
  }

  reloadDevicesAndSend(number, recurse) {
    return () =>
      this.store.getDeviceIds(number).then(deviceIds => {
        if (deviceIds.length === 0) {
          return this.registerError(
            number,
            "Got empty device list when loading device keys",
            null
          );
        }
        return this.doSendMessage(number, deviceIds, recurse);
      });
  }

  getKeysForNumber(number, updateDevices) {
    const handleResult = response =>
      Promise.all(
        response.devices.map(device => {
          // eslint-disable-next-line no-param-reassign
          device.identityKey = response.identityKey;
          if (
            updateDevices === undefined ||
            updateDevices.indexOf(device.deviceId) > -1
          ) {
            const address = new libsignal.SignalProtocolAddress(
              number,
              device.deviceId
            );
            const builder = new libsignal.SessionBuilder(this.store, address);
            if (device.registrationId === 0) {
              console.info("device registrationId 0!");
            }
            return builder.processPreKey(device).catch(error => {
              if (error.message === "Identity key changed") {
                // eslint-disable-next-line no-param-reassign
                error.timestamp = this.timestamp;
                // eslint-disable-next-line no-param-reassign
                error.originalMessage = Content.encode(this.message).finish();
                // eslint-disable-next-line no-param-reassign
                error.identityKey = device.identityKey;
              }
              throw error;
            });
          }

          return null;
        })
      );

    if (updateDevices === undefined) {
      return this.server.getKeysForNumber(number).then(handleResult);
    }
    let promise = Promise.resolve();
    updateDevices.forEach(device => {
      promise = promise.then(() =>
        this.server
          .getKeysForNumber(number, device)
          .then(handleResult)
          .catch(e => {
            if (e.name === "HTTPError" && e.code === 404) {
              if (device !== 1) {
                return this.removeDeviceIdsForNumber(number, [device]);
              }
              throw new errors.UnregisteredUserError(number, e);
            } else {
              throw e;
            }
          })
      );
    });

    return promise;
  }

  transmitMessage(number, jsonData, timestamp) {
    return this.server
      .sendMessages(number, jsonData, timestamp, this.silent)
      .catch(e => {
        if (e.name === "HTTPError" && (e.code !== 409 && e.code !== 410)) {
          // 409 and 410 should bubble and be handled by doSendMessage
          // 404 should throw UnregisteredUserError
          // all other network errors can be retried later.
          if (e.code === 404) {
            throw new errors.UnregisteredUserError(number, e);
          }
          throw new errors.SendMessageNetworkError(
            number,
            jsonData,
            e,
            timestamp
          );
        }
        throw e;
      });
  }

  getPaddedMessageLength(messageLength) {
    const messageLengthWithTerminator = messageLength + 1;
    let messagePartCount = Math.floor(messageLengthWithTerminator / 160);

    if (messageLengthWithTerminator % 160 !== 0) {
      messagePartCount += 1;
    }

    return messagePartCount * 160;
  }

  getPlaintext() {
    if (!this.plaintext) {
      const messageBuffer = Content.encode(this.message).finish();
      this.plaintext = new Uint8Array(
        this.getPaddedMessageLength(messageBuffer.byteLength + 1) - 1
      );
      this.plaintext.set(new Uint8Array(messageBuffer));
      this.plaintext[messageBuffer.byteLength] = 0x80;
    }
    return this.plaintext;
  }

  doSendMessage(number, deviceIds, recurse) {
    const ciphers = {};
    const plaintext = this.getPlaintext();

    return Promise.all(
      deviceIds.map(deviceId => {
        const address = new libsignal.SignalProtocolAddress(number, deviceId);

        const ourNumber = this.store.userGetNumber();
        const options = {};

        // No limit on message keys if we're communicating with our other devices
        if (ourNumber === number) {
          options.messageKeysLimit = false;
        }

        const sessionCipher = new libsignal.SessionCipher(
          this.store,
          address,
          options
        );
        ciphers[address.getDeviceId()] = sessionCipher;
        return sessionCipher.encrypt(plaintext).then(ciphertext => ({
          type: ciphertext.type,
          destinationDeviceId: address.getDeviceId(),
          destinationRegistrationId: ciphertext.registrationId,
          content: btoa(ciphertext.body)
        }));
      })
    )
      .then(jsonData =>
        this.transmitMessage(number, jsonData, this.timestamp).then(() => {
          this.successfulNumbers[this.successfulNumbers.length] = number;
          this.numberCompleted();
        })
      )
      .catch(error => {
        if (
          error instanceof Error &&
          error.name === "HTTPError" &&
          (error.code === 410 || error.code === 409)
        ) {
          if (!recurse)
            return this.registerError(
              number,
              "Hit retry limit attempting to reload device list",
              error
            );

          let p;
          if (error.code === 409) {
            p = this.removeDeviceIdsForNumber(
              number,
              error.response.extraDevices
            );
          } else {
            p = Promise.all(
              error.response.staleDevices.map(deviceId =>
                ciphers[deviceId].closeOpenSessionForDevice()
              )
            );
          }

          return p.then(() => {
            const resetDevices =
              error.code === 410
                ? error.response.staleDevices
                : error.response.missingDevices;
            return this.getKeysForNumber(number, resetDevices).then(
              this.reloadDevicesAndSend(number, error.code === 409)
            );
          });
        } else if (error.message === "Identity key changed") {
          // eslint-disable-next-line no-param-reassign
          error.timestamp = this.timestamp;
          // eslint-disable-next-line no-param-reassign
          error.originalMessage = Content.encode(this.message).finish();
          console.error(
            'Got "key changed" error from encrypt - no identityKey for application layer',
            number,
            deviceIds
          );
          throw error;
        } else {
          this.registerError(number, "Failed to create or send message", error);
        }

        return null;
      });
  }

  getStaleDeviceIdsForNumber(number) {
    return this.store.getDeviceIds(number).then(deviceIds => {
      if (deviceIds.length === 0) {
        return [1];
      }
      const updateDevices = [];
      return Promise.all(
        deviceIds.map(deviceId => {
          const address = new libsignal.SignalProtocolAddress(number, deviceId);
          const sessionCipher = new libsignal.SessionCipher(
            this.store,
            address
          );
          return sessionCipher.hasOpenSession().then(hasSession => {
            if (!hasSession) {
              updateDevices.push(deviceId);
            }
          });
        })
      ).then(() => updateDevices);
    });
  }

  removeDeviceIdsForNumber(number, deviceIdsToRemove) {
    let promise = Promise.resolve();
    // eslint-disable-next-line no-restricted-syntax, guard-for-in
    for (const j in deviceIdsToRemove) {
      promise = promise.then(() => {
        const encodedNumber = `${number}.${deviceIdsToRemove[j]}`;
        return this.store.removeSession(encodedNumber);
      });
    }
    return promise;
  }

  sendToNumber(number) {
    return this.getStaleDeviceIdsForNumber(number).then(updateDevices =>
      this.getKeysForNumber(number, updateDevices)
        .then(this.reloadDevicesAndSend(number, true))
        .catch(error => {
          if (error.message === "Identity key changed") {
            // eslint-disable-next-line no-param-reassign
            error = new errors.OutgoingIdentityKeyError(
              number,
              error.originalMessage,
              error.timestamp,
              error.identityKey
            );
            this.registerError(number, "Identity key changed", error);
          } else {
            this.registerError(
              number,
              `Failed to retrieve new device keys for number ${number}`,
              error
            );
          }
        })
    );
  }
}

exports = module.exports = OutgoingMessage;
