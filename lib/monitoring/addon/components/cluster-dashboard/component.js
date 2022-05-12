import C from 'ui/utils/constants';
import { on } from '@ember/object/evented';
import Component from '@ember/component';
import {
  set, get, computed, observer, setProperties
} from '@ember/object';
import { alias } from '@ember/object/computed';
import { inject as service } from '@ember/service';
import layout from './template';
import CatalogUpgrade from 'shared/mixins/catalog-upgrade';
import { next } from '@ember/runloop';
const MONITORING_TEMPLATE = 'system-library-rancher-monitoring';

export default Component.extend(CatalogUpgrade, {
  intl:        service(),
  scope:       service(),
  grafana:     service(),
  globalStore: service(),
  router:      service(),

  layout,

  nodes:             null,
  components:        null,
  showClusterTabs:   true,
  templateId:        MONITORING_TEMPLATE,
  isEmbedded:        false,
  monitoringEnabled: alias('scope.currentCluster.enableClusterMonitoring'),
  isMonitoringReady: alias('scope.currentCluster.isMonitoringReady'),
  componentStatuses: alias('scope.currentCluster.componentStatuses'),

  init() {
    this._super(...arguments);

    const embedded = window.top !== window;

    set(this, 'isEmbedded', embedded);
  },

  actions: {
    edit() {
      this.cluster.send('edit');
    },
    rotate() {
      this.cluster.send('rotateCertificates');
    },
    enableMonitoring() {
      get(this, 'router').transitionTo('authenticated.cluster.monitoring.cluster-setting');
    },
    addHost() {
      this.cluster.send('showCommandModal')
    }
  },

  clusterDidChange: observer('scope.currentCluster.id', function() {
    set(this, 'showClusterTabs', false);
    next(() => {
      if ( this.isDestroyed || this.isDestroying ) {
        return;
      }

      set(this, 'showClusterTabs', true);
    });
  }),

  setComponents: on('init', observer('componentStatuses.@each.conditions', 'nodes.@each.{state}', function() {
    setProperties(this, {
      etcdHealthy:       this.isHealthy('etcd'),
      controllerHealthy: this.isHealthy('controller-manager'),
      schedulerHealthy:  this.isHealthy('scheduler'),
      nodesHealthy:      get(this, 'inactiveNodes.length') === 0
    })
  })),

  showDashboard: computed('scope.currentCluster.isReady', 'nodes.[]', function() {
    return get(this, 'nodes').length && get(this, 'scope.currentCluster.isReady')
  }),

  inactiveNodes: computed('nodes.@each.state', function() {
    return get(this, 'nodes').filter( (n) => C.ACTIVEISH_STATES.indexOf(get(n, 'state')) === -1 );
  }),

  unhealthyComponents: computed('componentStatuses.@each.conditions', function() {
    return (get(this, 'componentStatuses') || [])
      .filter((s) => !s.conditions.any((c) => c.status === 'True'));
  }),

  whichComponentStatusExists: computed('cluster.componentStatuses.@each.{name,conditions}', function() {
    const out = {
      etcd:              false,
      scheduler:         false,
      controllerManager: false,
    }
    const componentStatuses = get(this, 'cluster.componentStatuses') || [];

    componentStatuses.forEach((status) => {
      if (status?.conditions?.firstObject?.type === 'Healthy' && status?.conditions?.firstObject?.status) {
        if (status?.name.includes('etcd')) {
          set(out, 'etcd', true);
        } else if (status?.name.includes('controller-manager')) {
          set(out, 'controllerManager', true);
        } else if (status?.name.includes('scheduler')) {
          set(out, 'scheduler', true);
        }
      }
    });

    return out;
  }),

  // Newer k8s does not have componentStatuses, so hide them all
  haveComponentStatus: computed('cluster.componentStatuses.@each.{name,conditions}', function() {
    return !!get(this, 'cluster.componentStatuses');
  }),

  hideEtcdStatus: computed('cluster.clusterProvider', function() {
    const { clusterProvider } = this.cluster;

    return C.GRAY_OUT_ETCD_STATUS_PROVIDERS.indexOf(clusterProvider) > -1;
  }),

  isHealthy(field) {
    const matching = (get(this, 'componentStatuses') || []).filter((s) => s.name.startsWith(field));

    // If there's no matching component status, it's "healthy"
    if ( !matching.length ) {
      return true;
    }

    return matching.any((s) => s.conditions.any((c) => c.status === 'True'));
  }
});
