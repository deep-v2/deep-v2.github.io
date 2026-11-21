// Menu bar slot for KbauBlocks live collaboration (the UI itself is plain DOM in lib/kbau-collab/ui.js).
// Part of the KbauBlocks patch set, GPL-3.0.
import PropTypes from 'prop-types';
import React from 'react';
import {mountCollab} from '../../lib/kbau-collab/ui.js';

class KbauCollab extends React.Component {
    componentDidMount () {
        try {
            this.unmount = mountCollab(this.root, () => this.props);
        } catch (e) {
            // Never let collaboration break the editor.
            console.error('[collab] could not start', e);
        }
    }
    componentWillUnmount () {
        if (this.unmount) this.unmount();
    }
    render () {
        return (
            <div
                className={this.props.className}
                ref={el => {
                    this.root = el;
                }}
            />
        );
    }
}

KbauCollab.propTypes = {
    className: PropTypes.string,
    projectChanged: PropTypes.bool,
    projectTitle: PropTypes.string,
    vm: PropTypes.object.isRequired
};

export default KbauCollab;
