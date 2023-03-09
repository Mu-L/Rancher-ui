import { alias } from '@ember/object/computed';
import {
  get, set, computed, observer, setProperties
} from '@ember/object';
import Component from '@ember/component';
import NodeDriver from 'shared/mixins/node-driver';
import layout from './template';
import jsyaml from 'js-yaml'
import { inject as service } from '@ember/service';
import { throttledObserver } from 'ui/utils/debounce';
import { hash } from 'rsvp';
import YAML from 'yaml';

const DRIVER = 'harvester';
const CONFIG = 'harvesterConfig';

const SYSTEM_NAMESPACES = [
  'cattle-dashboards',
  'cattle-global-data',
  'cattle-system',
  'gatekeeper-system',
  'ingress-nginx',
  'kube-node-lease',
  'kube-public',
  'kube-system',
  'linkerd',
  'rio-system',
  'security-scan',
  'tekton-pipelines',
];

const TYPE = {
  AFFINITY:      'affinity',
  ANTI_AFFINITY: 'antiAffinity'
};

const PRIORITY = {
  REQUIRED:  'required',
  PREFERRED: 'preferred'
};

const STORAGE_NETWORK = 'storage-network.settings.harvesterhci.io'

// init qemu guest agent
export const QGA_JSON = {
  package_update: true,
  packages:       ['qemu-guest-agent'],
  runcmd:         [
    [
      'systemctl',
      'enable',
      '--now',
      'qemu-guest-agent.service'
    ]
  ]
};
// Different operating systems may have different guest agents
export const QGA_MAP = { default: 'qemu-guest-agent.service' };

export default Component.extend(NodeDriver, {
  growl:     service(),
  settings: service(),
  intl:     service(),

  layout,
  driverName:           DRIVER,
  model:                {},

  currentCluster:      null,
  clusters:            [],
  clusterContent:      [],
  imageContent:        [],
  networkContent:      [],
  namespaceContent:    [],
  nodes:               [],
  namespaces:          [],
  nodeSchedulings:     [],
  podSchedulings:      [],
  networkDataContent:  [],
  storageClassContent: [],
  defaultStorageClass: '',
  userDataContent:     [],
  controller:          null,
  signal:              '',
  isImportMode:        true,
  loading:             false,
  disks:               [],
  interfaces:          [],
  installAgent:        false,
  userDataTemplate:    '',

  config: alias(`model.${ CONFIG }`),

  init() {
    this._super(...arguments);
    const controller = new AbortController();

    set(this, 'controller', controller);

    this.fetchResource();

    if (!!get(this, 'config.vmAffinity')) {
      this.initSchedulings();
    }

    this.initUserData();

    this.initDisks()

    this.initInterfaces()
  },

  actions: {
    async finishAndSelectCloudCredential(credential) {
      await this.globalStore.findAll('cloudcredential', { forceReload: true });
      set(this, 'model.cloudCredentialId', get(credential, 'id'));
    },

    updateYaml(type, value) {
      set(this,  `config.${ type }`, value);
    },

    addNodeScheduling() {
      const neu = {
        priority:          PRIORITY.REQUIRED,
        nodeSelectorTerms: { matchExpressions: [] },
      };

      this.get('nodeSchedulings').pushObject(neu);
    },

    addVolume(type) {
      let neu = {}

      if (type === 'volume') {
        neu = {
          storageClassName: get(this, 'defaultStorageClass'),
          size:             10,
          bootOrder:        0
        };
      } else if (type === 'image') {
        neu = {
          imageName: '',
          size:      40,
          bootOrder: 0
        };
      }

      this.get('disks').pushObject(neu);
    },

    addNetwork() {
      const neu = {
        networkName: '',
        macAddress:  ''
      }

      this.get('interfaces').pushObject(neu);
    },

    removeNodeScheduling(scheduling) {
      this.get('nodeSchedulings').removeObject(scheduling);
    },

    removeDisk(disk) {
      this.get('disks').removeObject(disk);
    },

    removeNetwork(network) {
      this.get('interfaces').removeObject(network);
    },

    updateNodeScheduling() {
      this.parseNodeScheduling();
    },

    addPodScheduling() {
      const neu = {
        type:          TYPE.AFFINITY,
        priority:      PRIORITY.REQUIRED,
        labelSelector: { matchExpressions: [] },
        topologyKey:   ''
      };

      this.get('podSchedulings').pushObject(neu);
    },

    removePodScheduling(scheduling) {
      this.get('podSchedulings').removeObject(scheduling);
    },

    updatePodScheduling() {
      this.parsePodScheduling();
    },

    updateAgent() {
      const isInstall = !get(this, 'installAgent');

      set(this, 'installAgent', isInstall)
      const userData = get(this, 'config.userData')

      const userDataDoc = isInstall ? this.addGuestAgent(userData) : this.deleteGuestAgent(userData);
      let userDataYaml = userDataDoc.toString();

      if (userDataYaml === '{}\n') {
        // When the YAML parsed value is '{}\n', it means that the userData is empty.
        userDataYaml = '';
      }

      const hasCloudComment = this.hasCloudConfigComment(userDataYaml);

      if (!hasCloudComment) {
        userDataYaml = `#cloud-config\n${ userDataYaml }`;
      }

      set(this, 'config.userData', userDataYaml);
    },

    chooseUserDataTemplate() {
      const templateValue = get(this, 'userDataTemplate');
      const isInstallAgent = get(this, 'installAgent');

      try {
        const templateJsonData = this.convertToJson(templateValue);

        let userDataYaml;

        if (isInstallAgent) {
          const mergedObj = Object.assign(templateJsonData, { ...QGA_JSON });

          userDataYaml = this.addCloudConfigComment(mergedObj);
        } else {
          userDataYaml = templateValue;
        }

        set(this, 'config.userData', userDataYaml)
      } catch (e) {
        const message = this.intl.t('nodeDriver.harvester.templateError')

        get(this, 'growl').fromError(undefined, message);
      }
    },
  },

  clearData: observer('currentCredential.id', function() {
    set(this, 'config.imageName', '');
    set(this, 'config.networkName', '');
    set(this, 'config.vmNamespace', '');
    set(this, 'nodeSchedulings', []);
    set(this, 'podSchedulings', []);
    set(this, 'vmAffinity', {});
    set(this, 'config.vmAffinity', '');
    set(this, 'config.diskInfo', '');
    set(this, 'config.networkInfo', '');

    this.initUserData();
    this.initDisks()
    this.initInterfaces()
  }),

  setDiskInfo: observer('disks.@each.{imageName,bootOrder,storageClassName,size}', function() {
    const diskInfo = {
      disks: get(this, 'disks').map((disk) => {
        return {
          ...disk,
          size: Number(disk.size),
        };
      })
    };

    set(this, 'config.diskInfo', JSON.stringify(diskInfo));
  }),

  setNetworkInfo: observer('interfaces.@each.{networkName,macAddress}', function() {
    const networkInfo = { interfaces: get(this, 'interfaces') };

    set(this, 'config.networkInfo', JSON.stringify(networkInfo))
  }),

  nodeSchedulingsChanged: observer('nodeSchedulings.[]', function() {
    this.parseNodeScheduling();
  }),

  podSchedulingsChanged: observer('podSchedulings.[]', function() {
    this.parsePodScheduling();
  }),

  userDataChanged: observer('config.userData', function() {
    const userData = get(this, 'config.userData');
    const installAgent = get(this, 'installAgent')
    const hasInstall = this.hasInstallAgent(userData, installAgent);

    set(this, 'installAgent', hasInstall)
  }),

  fetchResource: throttledObserver('currentCredential.id', 'currentCredential.harvestercredentialConfig.clusterId', async function() {
    const clusterId = get(this, 'currentCredential') && get(this, 'currentCredential').harvestercredentialConfig && get(this, 'currentCredential').harvestercredentialConfig.clusterId;

    const url = clusterId  === 'local' ? '' : `/k8s/clusters/${ clusterId }`;

    if (!clusterId) {
      return;
    }

    let controller = get(this, 'controller');
    let signal = get(this, 'signal');

    signal = controller.signal;
    set(this, 'signal', signal);

    set(this, 'loading', true);

    hash({ nodes: get(this, 'globalStore').rawRequest({ url: `${ url }/v1/node` }) }).then((resp) => {
      set(this, 'nodes', resp.nodes.body.data || []);
    }).catch((err) => {
      const message = err.statusText || err.message;

      set(this, 'nodes', []);
      get(this, 'growl').fromError('Error request Node API', message);
    })

    hash({
      images:          get(this, 'globalStore').rawRequest({ url: `${ url }/v1/harvesterhci.io.virtualmachineimages` }),
      networks:        get(this, 'globalStore').rawRequest({ url: `${ url }/v1/k8s.cni.cncf.io.networkattachmentdefinition` }),
      namespaces:      get(this, 'globalStore').rawRequest({ url: `${ url }/v1/namespace` }),
      configmaps:      get(this, 'globalStore').rawRequest({ url: `${ url }/v1/configmap` }),
      storageClass:    get(this, 'globalStore').rawRequest({ url: `${ url }/v1/storage.k8s.io.storageclasses` }),
      systemNamespace: get(this, 'globalStore').rawRequest({ url: `${ url }/v1/management.cattle.io.settings/system-namespaces` }),
    }).then((resp) => {
      const images = resp.images.body.data || [];
      const imageContent = images.filter((O) => {
        return !O.spec.url.endsWith('.iso') && this.isReady.call(O);
      }).map((O) => {
        const value = O.id;
        const label = `${ O.spec.displayName } (${ value })`;

        return {
          label,
          value
        }
      });

      const networks = resp.networks.body.data || [];
      const networkContent = networks.filter((O) => {
        return O.metadata?.annotations?.[STORAGE_NETWORK] !== 'true'
      }).map((O) => {
        let id = '';

        try {
          const config = JSON.parse(O.spec.config);

          id = config.vlan;
        } catch (err) {
          get(this, 'growl').fromError('Error parse network config', err);
        }

        const value = O.id;
        const label = `${ value } (vlanId=${ id })`;

        return {
          label,
          value
        }
      });

      const systemNamespaceValue  = resp.systemNamespace.body.value || '';
      const systemNamespaces = systemNamespaceValue.split(',');

      const namespaces = resp.namespaces.body.data || [];
      const namespaceContent = namespaces
        .filter((O) => {
          return !this.isSystemNamespace(O) && O.links.update && !systemNamespaces.includes(O.metadata.name);
        })
        .map((O) => {
          const value = O.id;
          const label = O.id;

          return {
            label,
            value
          }
        });

      const configmaps = resp.configmaps.body.data || [];
      const networkDataContent = [];
      const userDataContent = [];

      configmaps.map((O) => {
        const cloudTemplate = O.metadata && O.metadata.labels && O.metadata.labels['harvesterhci.io/cloud-init-template'];
        const value = O.data && O.data.cloudInit;
        const label = O.metadata.name;

        if (cloudTemplate === 'user') {
          userDataContent.push({
            label,
            value
          })
        } else if (cloudTemplate === 'network') {
          networkDataContent.push({
            label,
            value
          })
        }
      })

      const storageClass = resp.storageClass.body.data || [];
      let defaultStorageClass = '';
      const storageClassContent = storageClass.filter((s) => !s.parameters?.backingImage).map((s) => {
        const isDefault = s.metadata?.annotations?.['storageclass.kubernetes.io/is-default-class'] === 'true';
        const label = isDefault ? `${ s.metadata.name } (${ this.intl.t('generic.default') })` : s.metadata.name;

        if (isDefault) {
          defaultStorageClass = s.metadata.name;
        }

        return {
          label,
          value: s.metadata.name,
        };
      }) || [];

      setProperties(this, {
        imageContent,
        networkContent,
        namespaceContent,
        userDataContent,
        networkDataContent,
        storageClassContent,
        defaultStorageClass
      });
    }).catch((err) => {
      setProperties(this, {
        imageContent:        [],
        networkContent:      [],
        namespaceContent:    [],
        userDataContent:     [],
        networkDataContent:  [],
        namespaces:          [],
        vmAffinity:          [],
        nodeSchedulings:     [],
        podSchedulings:      [],
        storageClassContent: [],
      })

      const message = err.statusText || err.message;

      get(this, 'growl').fromError('Error request Image API', message);
    }).finally(() => {
      set(this, 'loading', false);
    })

    controller.abort()
  }),

  harvestercredentialConfig: computed('cloudCredentials.@each.harvestercredentialConfig', function() {
    return (get(this, 'cloudCredentials') || []).mapBy('harvestercredentialConfig')
  }),

  currentCredential: computed('cloudCredentials', 'harvestercredentialConfig.[]', 'model.cloudCredentialId', function() {
    return (get(this, 'cloudCredentials') || []).find((C) => C.id === get(this, 'model.cloudCredentialId'));
  }),

  isSystemNamespace(namespace) {
    if ( namespace.metadata && namespace.metadata.annotations && namespace.metadata.annotations['management.cattle.io/system-namespace'] === 'true' ) {
      return true;
    }

    if (namespace.metadata.labels['fleet.cattle.io/managed'] === 'true') {
      return true;
    }

    if ( SYSTEM_NAMESPACES.includes(namespace.metadata.name) ) {
      return true;
    }

    if ( namespace.metadata && namespace.metadata.name && namespace.metadata.name.endsWith('-system') ) {
      return true;
    }

    return false;
  },

  bootstrap() {
    let config = get(this, 'globalStore').createRecord({
      type:                    CONFIG,
      cpuCount:                2,
      memorySize:              4,
      diskSize:                40,
      diskBus:                 'virtio',
      imageName:               '',
      sshUser:                 '',
      networkName:             '',
      networkData:             '',
      vmNamespace:             '',
      userData:                '',
      vmAffinity:              '',
      diskInfo:                '',
      networkInfo:             ''
    });

    set(this, `model.${ CONFIG }`, config);
  },

  addGuestAgent(userData) {
    const userDataDoc = userData ? YAML.parseDocument(userData) : YAML.parseDocument({});
    const userDataYAML = userDataDoc.toString();
    const userDataJSON = YAML.parse(userDataYAML);
    let packages = userDataJSON?.packages || [];
    let runcmd = userDataJSON?.runcmd || [];

    userDataDoc.setIn(['package_update'], true);
    if (Array.isArray(packages)) {
      if (!packages.includes('qemu-guest-agent')) {
        packages.push('qemu-guest-agent');
      }
    } else {
      packages = QGA_JSON.packages;
    }
    if (Array.isArray(runcmd)) {
      const hasSameRuncmd = runcmd.find( (S) => Array.isArray(S) && S.join('-') === QGA_JSON.runcmd[0].join('-'));

      if (!hasSameRuncmd) {
        runcmd.push(QGA_JSON.runcmd[0]);
      }
    } else {
      runcmd = QGA_JSON.runcmd;
    }
    if (packages.length > 0) {
      userDataDoc.setIn(['packages'], packages);
    } else {
      userDataDoc.setIn(['packages'], []); // It needs to be set empty first, as it is possible that cloud-init comments are mounted on this node
      this.deleteYamlDocProp(userDataDoc, ['packages']);
      this.deleteYamlDocProp(userDataDoc, ['package_update']);
    }
    if (runcmd.length > 0) {
      userDataDoc.setIn(['runcmd'], runcmd);
    } else {
      this.deleteYamlDocProp(userDataDoc, ['runcmd']);
    }

    return userDataDoc;
  },

  deleteGuestAgent(userData) {
    const userDataDoc = userData ? YAML.parseDocument(userData) : YAML.parseDocument({});
    const userDataYAML = userDataDoc.toString();
    const userDataJSON = YAML.parse(userDataYAML);
    const packages = userDataJSON?.packages || [];
    const runcmd = userDataJSON?.runcmd || [];

    if (Array.isArray(packages)) {
      for (let i = 0; i < packages.length; i++) {
        if (packages[i] === 'qemu-guest-agent') {
          packages.splice(i, 1);
        }
      }
    }
    if (Array.isArray(runcmd)) {
      for (let i = 0; i < runcmd.length; i++) {
        if (Array.isArray(runcmd[i]) && runcmd[i].join('-') === QGA_JSON.runcmd[0].join('-')) {
          runcmd.splice(i, 1);
        }
      }
    }
    if (packages.length > 0) {
      userDataDoc.setIn(['packages'], packages);
    } else {
      userDataDoc.setIn(['packages'], []);
      this.deleteYamlDocProp(userDataDoc, ['packages']);
      this.deleteYamlDocProp(userDataDoc, ['package_update']);
    }
    if (runcmd.length > 0) {
      userDataDoc.setIn(['runcmd'], runcmd);
    } else {
      this.deleteYamlDocProp(userDataDoc, ['runcmd']);
    }

    return userDataDoc;
  },

  hasCloudConfigComment(userScript) {
    // Check that userData contains: #cloud-config
    const userDataDoc = userScript ? YAML.parseDocument(userScript) : YAML.parseDocument({});

    const items = userDataDoc?.contents?.items || [];
    let exist = false;

    if (userDataDoc?.comment === 'cloud-config' || userDataDoc?.comment?.includes('cloud-config\n')) {
      exist = true;
    }

    if (userDataDoc?.commentBefore === 'cloud-config' || userDataDoc?.commentBefore?.includes('cloud-config\n')) {
      exist = true;
    }

    items.map((item) => {
      const key = item.key;

      if (key?.commentBefore?.trim() === 'cloud-config' || key?.commentBefore?.includes('cloud-config\n') || /\ncloud-config$/.test(key?.commentBefore)) {
        exist = true;
      }
    });

    return exist;
  },

  deleteYamlDocProp(doc, paths) {
    try {
      const item = doc.getIn([])?.items[0];
      const key = item?.key;
      const hasCloudConfigComment = !!key?.commentBefore?.includes('cloud-config');
      const isMatchProp = key.source === paths[paths.length - 1];

      if (key && hasCloudConfigComment && isMatchProp) {
        // Comments are mounted on the next node and we should not delete the node containing cloud-config
      } else {
        doc.deleteIn(paths);
      }
    } catch (e) {}
  },

  validate() {
    this._super();
    let errors = get(this, 'errors') || [];

    if (!this.validateCloudCredentials()) {
      errors.push(this.intl.t('nodeDriver.cloudCredentialError'))
    }

    if (!get(this, 'config.vmNamespace')) {
      errors.push(this.intl.t('generic.required', { key: this.intl.t('nodeDriver.harvester.namespace.label') }));
    }

    if (!get(this, 'config.sshUser')) {
      errors.push(this.intl.t('generic.required', { key: this.intl.t('nodeDriver.harvester.sshUser.label') }));
    }

    this.validateScheduling(errors);

    this.validateDiskAndNetwork(errors);

    // Set the array of errors for display,
    // and return true if saving should continue.

    if (errors.length) {
      set(this, 'errors', errors.uniq());

      return false;
    }

    return true;
  },

  isReady() {
    function getStatusConditionOfType(type, defaultValue = []) {
      const conditions = Array.isArray(get(this, 'status.conditions')) ? this.status.conditions : defaultValue;

      return conditions.find( (cond) => cond.type === type);
    }

    const initialized = getStatusConditionOfType.call(this, 'Initialized');
    const imported = getStatusConditionOfType.call(this, 'Imported');
    const isCompleted = this.status?.progress === 100;

    if ([initialized?.status, imported?.status].includes('False')) {
      return false;
    } else {
      return isCompleted && true;
    }
  },

  isEmptyObject(obj) {
    return obj
    && Object.keys(obj).length === 0
    && Object.getPrototypeOf(obj) === Object.prototype;
  },

  isImageVolume(volume) {
    return Object.prototype.hasOwnProperty.call(volume, 'imageName');
  },

  initSchedulings() {
    const nodeSchedulings = [];
    const podSchedulings = [];
    const parsedObj = JSON.parse(AWS.util.base64.decode(get(this, 'config.vmAffinity')).toString());
    const nodeAffinityRequired = get(parsedObj, 'nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution');
    const nodeAffinityPreferred = get(parsedObj, 'nodeAffinity.preferredDuringSchedulingIgnoredDuringExecution');
    const podAffinityRequired = get(parsedObj, 'podAffinity.requiredDuringSchedulingIgnoredDuringExecution');
    const podAffinityPreferred = get(parsedObj, 'podAffinity.preferredDuringSchedulingIgnoredDuringExecution');
    const podAntiAffinityRequired = get(parsedObj, 'podAntiAffinity.requiredDuringSchedulingIgnoredDuringExecution');
    const podAntiAffinityPreferred = get(parsedObj, 'podAntiAffinity.preferredDuringSchedulingIgnoredDuringExecution');

    if (nodeAffinityRequired) {
      nodeAffinityRequired.nodeSelectorTerms.forEach((S) => {
        nodeSchedulings.push({
          priority:          PRIORITY.REQUIRED,
          nodeSelectorTerms: { matchExpressions: S.matchExpressions },
        })
      });
    }

    if (nodeAffinityPreferred) {
      nodeAffinityPreferred.forEach((S) => {
        nodeSchedulings.push({
          priority:          PRIORITY.PREFERRED,
          nodeSelectorTerms: { matchExpressions: S.preference.matchExpressions },
        })
      });
    }

    if (podAffinityRequired) {
      podAffinityRequired.forEach((S) => {
        podSchedulings.push({
          type:          TYPE.AFFINITY,
          priority:      PRIORITY.REQUIRED,
          labelSelector: { matchExpressions: S.labelSelector.matchExpressions },
          topologyKey:   S.topologyKey,
          namespaces:    S.namespaces || [],
          weight:        S.weight || ''
        })
      });
    }

    if (podAffinityPreferred) {
      podAffinityPreferred.forEach((S) => {
        podSchedulings.push({
          type:          TYPE.AFFINITY,
          priority:      PRIORITY.PREFERRED,
          labelSelector: { matchExpressions: S.podAffinityTerm.labelSelector.matchExpressions },
          topologyKey:   S.podAffinityTerm.topologyKey,
          namespaces:    get(S, 'podAffinityTerm.namespaces') || [],
          weight:        get(S, 'podAffinityTerm.weight') || ''
        })
      });
    }

    if (podAntiAffinityRequired) {
      podAntiAffinityRequired.forEach((S) => {
        podSchedulings.push({
          type:          TYPE.ANTI_AFFINITY,
          priority:      PRIORITY.REQUIRED,
          labelSelector: { matchExpressions: S.labelSelector.matchExpressions },
          topologyKey:   S.topologyKey,
          namespaces:    S.namespaces || [],
          weight:        S.weight || ''
        })
      });
    }

    if (podAntiAffinityPreferred) {
      podAntiAffinityPreferred.forEach((S) => {
        podSchedulings.push({
          type:          TYPE.ANTI_AFFINITY,
          priority:      PRIORITY.PREFERRED,
          labelSelector: { matchExpressions: S.podAffinityTerm.labelSelector.matchExpressions },
          topologyKey:   S.podAffinityTerm.topologyKey,
          namespaces:    get(S, 'podAffinityTerm.namespaces') || [],
          weight:        get(S, 'podAffinityTerm.weight') || ''
        })
      });
    }

    set(this, 'nodeSchedulings', nodeSchedulings);
    set(this, 'podSchedulings', podSchedulings);
  },

  initUserData() {
    if (!get(this, 'config.userData')) {
      let userData = this.addCloudConfigComment(QGA_JSON);

      set(this, 'config.userData', userData)
    }

    const userData = get(this, 'config.userData')
    const hasInstall = this.hasInstallAgent(userData, true);

    set(this, 'installAgent', hasInstall)
  },

  initDisks() {
    let disks = [];

    if (!get(this, 'config.diskInfo')) {
      const imageName = get(this, 'config.imageName') || '';

      disks = [{
        imageName,
        bootOrder: 1,
        size:      40,
      }];

      if (get(this, 'config.diskBus')) {
        disks[0].bus = get(this, 'config.diskBus');
      }

      const diskInfo = JSON.stringify({ disks });

      set(this, 'config.diskInfo', diskInfo);
    } else {
      const diskInfo = get(this, 'config.diskInfo');

      disks = JSON.parse(diskInfo).disks || [];
    }
    set(this, 'disks', disks);
  },

  convertToJson(script = '') {
    let out = {};

    try {
      out = jsyaml.load(script);
    } catch (e) {
      throw new Error('Function(convertToJson) error');
    }

    return out;
  },

  hasInstallAgent(userScript, installAgent) {
    let dataFormat = {};

    try {
      dataFormat = this.convertToJson(userScript);
    } catch {
      // When the yaml cannot be converted to json, the previous installAgent value should be returned
      return installAgent;
    }
    const hasInstall = dataFormat?.packages?.includes('qemu-guest-agent') && !!dataFormat?.runcmd?.find( (S) => Array.isArray(S) && S.join('-') === QGA_JSON.runcmd[0].join('-'));

    return !!hasInstall;
  },

  addCloudConfigComment(value) {
    if (typeof value === 'object' && value !== null) {
      return `#cloud-config\n${ jsyaml.safeDump(value) }`;
    } else if (typeof value === 'string' && !value.startsWith('#cloud-config')) {
      return `#cloud-config\n${ value }`;
    } else if (typeof value === 'string') {
      return value;
    }
  },

  initInterfaces() {
    let _interfaces = [];

    if (!get(this, 'config.networkInfo')) {
      const networkName = get(this, 'config.networkName') || '';

      _interfaces = [{
        networkName,
        macAddress: '',
      }];

      if (get(this, 'config.networkModel')) {
        _interfaces[0].model = get(this, 'config.networkModel');
      }

      const networkInfo = JSON.stringify({ interfaces: _interfaces });

      set(this, 'config.networkInfo', networkInfo);
    } else {
      const networkInfo = get(this, 'config.networkInfo');

      _interfaces = JSON.parse(networkInfo).interfaces || [];
    }
    set(this, 'interfaces', _interfaces);
  },

  parseNodeScheduling() {
    const arr = this.nodeSchedulings;
    const out = {};

    if (arr.find((S) => S.priority === PRIORITY.REQUIRED)) {
      out.requiredDuringSchedulingIgnoredDuringExecution = { nodeSelectorTerms: [] }
    }

    if (arr.find((S) => S.priority === PRIORITY.PREFERRED)) {
      out.preferredDuringSchedulingIgnoredDuringExecution = [];
    }

    arr.forEach((S) => {
      if (S.priority === PRIORITY.REQUIRED) {
        out.requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms.push({ matchExpressions: S.nodeSelectorTerms.matchExpressions })
      }

      if (S.priority === PRIORITY.PREFERRED) {
        out.preferredDuringSchedulingIgnoredDuringExecution.push({ preference: { matchExpressions: S.nodeSelectorTerms.matchExpressions } })
      }
    })

    const parseObj = { ...get(this, 'vmAffinity') };

    if (!this.isEmptyObject(out)) {
      set(parseObj, 'nodeAffinity', out);
    } else {
      delete parseObj.nodeAffinity;
    }

    set(this, 'config.vmAffinity', this.isEmptyObject(parseObj) ? '' : AWS.util.base64.encode(JSON.stringify(parseObj)));
    set(this, 'vmAffinity', parseObj);
  },

  parsePodScheduling() {
    const arr = this.podSchedulings;
    const out = {};

    if (arr.find((S) => S.type === TYPE.AFFINITY)) {
      out.podAffinity = {};
    }

    if (arr.find((S) => S.type === TYPE.ANTI_AFFINITY)) {
      out.podAntiAffinity = {};
    }

    if (arr.find((S) => S.type === TYPE.AFFINITY && S.priority === PRIORITY.REQUIRED)) {
      out.podAffinity.requiredDuringSchedulingIgnoredDuringExecution = [];
    }

    if (arr.find((S) => S.type === TYPE.AFFINITY && S.priority === PRIORITY.PREFERRED)) {
      out.podAffinity.preferredDuringSchedulingIgnoredDuringExecution = [];
    }

    if (arr.find((S) => S.type === TYPE.ANTI_AFFINITY && S.priority === PRIORITY.REQUIRED)) {
      out.podAntiAffinity.requiredDuringSchedulingIgnoredDuringExecution = [];
    }

    if (arr.find((S) => S.type === TYPE.ANTI_AFFINITY && S.priority === PRIORITY.PREFERRED)) {
      out.podAntiAffinity.preferredDuringSchedulingIgnoredDuringExecution = [];
    }


    arr.forEach((S) => {
      const requiredObj = {
        labelSelector: S.labelSelector,
        topologyKey:   S.topologyKey,
      };

      const preferredObj = {
        podAffinityTerm: {
          labelSelector: S.labelSelector,
          topologyKey:   S.topologyKey
        }
      }

      if (S.namespaces) {
        requiredObj.namespaces = S.namespaces;
        preferredObj.podAffinityTerm.namespaces = S.namespaces;
      }

      if (S.weight) {
        requiredObj.weight = S.weight;
        preferredObj.weight = S.weight;
      }

      if (S.type === TYPE.AFFINITY && S.priority === PRIORITY.REQUIRED) {
        out.podAffinity.requiredDuringSchedulingIgnoredDuringExecution.push(requiredObj);
      }

      if (S.type === TYPE.AFFINITY && S.priority === PRIORITY.PREFERRED) {
        out.podAffinity.preferredDuringSchedulingIgnoredDuringExecution.push(preferredObj);
      }

      if (S.type === TYPE.ANTI_AFFINITY && S.priority === PRIORITY.REQUIRED) {
        out.podAntiAffinity.requiredDuringSchedulingIgnoredDuringExecution.push(requiredObj)
      }

      if (S.type === TYPE.ANTI_AFFINITY && S.priority === PRIORITY.PREFERRED) {
        out.podAntiAffinity.preferredDuringSchedulingIgnoredDuringExecution.push(preferredObj);
      }
    });

    const parseObj = { ...get(this, 'vmAffinity') }

    if (!this.isEmptyObject(get(out, 'podAffinity') || {})) {
      set(parseObj, 'podAffinity', get(out, 'podAffinity'));
    } else {
      delete parseObj.podAffinity;
    }

    if (!this.isEmptyObject(get(out, 'podAntiAffinity') || {})) {
      set(parseObj, 'podAntiAffinity', get(out, 'podAntiAffinity'));
    } else {
      delete parseObj.podAntiAffinity;
    }

    set(this, 'config.vmAffinity', this.isEmptyObject(parseObj) ? '' : AWS.util.base64.encode(JSON.stringify(parseObj)));
    set(this, 'vmAffinity', parseObj);
  },

  validateScheduling(errors) {
    if (get(this, 'podSchedulings').find((S) => !S.topologyKey)) {
      errors.push(this.intl.t('generic.required', { key: this.intl.t('nodeDriver.harvester.scheduling.input.topology.label') }));
    }

    const nodeHasMissingKey = get(this, 'nodeSchedulings').find((S) => {
      return get(S, 'nodeSelectorTerms.matchExpressions').find((M) => !get(M, 'key'));
    });

    const podHasMissingKey = get(this, 'podSchedulings').find((S) => {
      return get(S, 'labelSelector.matchExpressions').find((M) => !get(M, 'key'));
    });

    if (nodeHasMissingKey || podHasMissingKey) {
      errors.push(this.intl.t('generic.required', { key: this.intl.t('formNodeRequirement.key.label') }));
    }
  },

  isValidMac(value) {
    return /^[A-Fa-f0-9]{2}(-[A-Fa-f0-9]{2}){5}$|^[A-Fa-f0-9]{2}(:[A-Fa-f0-9]{2}){5}$/.test(value);
  },

  validateDiskAndNetwork(errors) {
    const disks = get(this, 'disks');

    disks.forEach((disk) => {
      if (Object.prototype.hasOwnProperty.call(disk, 'imageName') && !disk.imageName) {
        errors.push(this.intl.t('generic.required', { key: this.intl.t('nodeDriver.harvester.imageName.label') }));
      }

      if (Object.prototype.hasOwnProperty.call(disk, 'storageClassName') && !disk.storageClassName) {
        errors.push(this.intl.t('generic.required', { key: this.intl.t('nodeDriver.harvester.storageClass.label') }));
      }

      if (!disk.size) {
        errors.push(this.intl.t('generic.required', { key: this.intl.t('nodeDriver.harvester.diskSize.label') }));
      }

      if (!disk.size) {
        errors.push(this.intl.t('generic.required', { key: this.intl.t('nodeDriver.harvester.diskSize.label') }));
      }
    });

    const interfaces = get(this, 'interfaces');

    interfaces.forEach((_interface) => {
      if (!_interface.networkName) {
        errors.push(this.intl.t('generic.required', { key: this.intl.t('nodeDriver.harvester.networkName.label') }));
      }

      if (_interface.macAddress && !this.isValidMac(_interface.macAddress)) {
        errors.push(this.intl.t('generic.required', { key: this.intl.t('nodeDriver.harvester.network.macFormat') }));
      }
    });
  },
});
